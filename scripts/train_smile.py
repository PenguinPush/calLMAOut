# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["torch", "mediapipe", "pillow", "numpy", "onnx"]
# ///
"""Train the smiling/not-smiling CNN on the FEI Face Database.

Downloads FEI's manually aligned frontal images (Na.jpg = neutral, Nb.jpg = smiling)
into data/fei/, normalizes every face exactly like src/lib/face.ts does for webcam
photos, reports 5-fold cross-validation split by person, then trains on everyone and
writes public/models/smile.onnx.

FEI Face Database: research use only. C. E. Thomaz and G. A. Giraldi, "A new ranking
method for Principal Components Analysis and its application to face image analysis",
Image and Vision Computing, 28(6), 2010.
"""

import io
import json
import math
import random
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

import mediapipe as mp
import numpy as np
import torch
from PIL import Image, ImageFilter
from torch import nn

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "fei"
MODELS = ROOT / "public" / "models"
SPEC = json.loads((ROOT / "src" / "lib" / "face-spec.json").read_text())
SIZE = SPEC["size"]
DETECTOR = MODELS / "blaze_face_short_range.tflite"
FEI = "https://fei.edu.br/~cet/frontalimages_manuallyaligned_part{}.zip"

torch.manual_seed(0)
random.seed(0)
np.random.seed(0)


def download():
    raw = DATA / "raw"
    if len(list(raw.glob("*.jpg"))) < 400:
        raw.mkdir(parents=True, exist_ok=True)
        for part in (1, 2):
            print(f"Downloading FEI part {part}")
            zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(FEI.format(part)).read())).extractall(raw)
    return raw


def eyes(detector, image):
    """Pixel positions of the two eyes of the most confident face, left to right in the image."""
    result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image)))
    if not result.detections:
        return None
    face = max(result.detections, key=lambda d: d.categories[0].score)
    points = sorted((k.x * image.width, k.y * image.height) for k in face.keypoints[:2])
    return points


def align(image, eye_points, rotate=0.0, scale=1.0, shift=(0.0, 0.0)):
    """Same similarity transform as face.ts: the eyes land at the spec positions in a SIZE x SIZE crop.
    rotate/scale/shift perturb the target positions for augmentation."""
    (x1, y1), (x2, y2) = eye_points
    q1 = np.array([SPEC["leftEyeX"] * SIZE, SPEC["eyeY"] * SIZE])
    q2 = np.array([SPEC["rightEyeX"] * SIZE, SPEC["eyeY"] * SIZE])
    center = (q1 + q2) / 2
    c, s = math.cos(rotate), math.sin(rotate)
    turn = np.array([[c, -s], [s, c]]) * scale
    q1 = center + turn @ (q1 - center) + shift
    q2 = center + turn @ (q2 - center) + shift

    # Forward map source -> crop: q = k * R(theta) * (p - p1) + q1
    src, dst = np.array([x2 - x1, y2 - y1]), q2 - q1
    k = np.linalg.norm(dst) / np.linalg.norm(src)
    theta = math.atan2(dst[1], dst[0]) - math.atan2(src[1], src[0])
    # PIL wants the inverse map crop -> source: p = R(-theta) * (q - q1) / k + p1
    ci, si = math.cos(-theta) / k, math.sin(-theta) / k
    a, b, d, e = ci, -si, si, ci
    cx = x1 - (a * q1[0] + b * q1[1])
    cy = y1 - (d * q1[0] + e * q1[1])
    return image.transform((SIZE, SIZE), Image.AFFINE, (a, b, cx, d, e, cy), Image.BILINEAR)


def to_tensor(crop):
    """Grayscale, histogram-equalize and standardize, matching face.ts exactly."""
    rgb = np.asarray(crop, dtype=np.float64)
    gray = np.clip(np.round(rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114), 0, 255).astype(np.int64)
    hist = np.bincount(gray.ravel(), minlength=256)
    cdf = np.cumsum(hist)
    cdf_min = cdf[cdf > 0][0]
    denom = max(gray.size - cdf_min, 1)
    eq = np.round((cdf[gray] - cdf_min) / denom * 255) / 255
    return ((eq - eq.mean()) / (eq.std() + 1e-6)).astype(np.float32)


def augment(image, eye_points):
    """A webcam-ish variant: off-angle, off-center, different lighting, softer and noisier."""
    crop = align(
        image,
        eye_points,
        rotate=math.radians(random.uniform(-12, 12)),
        scale=random.uniform(0.9, 1.1),
        shift=(random.uniform(-4, 4), random.uniform(-4, 4)),
    )
    if random.random() < 0.5:
        crop = crop.transpose(Image.FLIP_LEFT_RIGHT)
    x = np.asarray(crop, dtype=np.float32) / 255
    x = x * random.uniform(0.6, 1.4) + random.uniform(-0.2, 0.2)  # contrast, brightness
    x = x * np.random.uniform(0.85, 1.15, 3)  # white balance
    x = np.clip(x, 0, 1) ** random.uniform(0.7, 1.5)  # gamma
    x = x + np.random.normal(0, random.uniform(0, 0.04), x.shape)  # sensor noise
    crop = Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))
    if random.random() < 0.4:
        crop = crop.filter(ImageFilter.GaussianBlur(random.uniform(0.3, 1.2)))
    if random.random() < 0.5:
        buffer = io.BytesIO()
        crop.save(buffer, "JPEG", quality=random.randint(30, 90))
        crop = Image.open(buffer).convert("RGB")
    return to_tensor(crop)


class SmileNet(nn.Module):
    def __init__(self):
        super().__init__()

        def block(i, o):
            return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(), nn.MaxPool2d(2))

        self.features = nn.Sequential(block(1, 16), block(16, 32), block(32, 64), nn.AdaptiveAvgPool2d(1))
        self.head = nn.Sequential(nn.Flatten(), nn.Dropout(0.3), nn.Linear(64, 1))

    def forward(self, x):
        return self.head(self.features(x))


def train(samples, epochs=60):
    model = SmileNet()
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-3)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=3e-3, total_steps=epochs * math.ceil(len(samples) / 32))
    loss_fn = nn.BCEWithLogitsLoss()
    for _ in range(epochs):
        model.train()
        random.shuffle(samples)
        for i in range(0, len(samples), 32):
            batch = samples[i : i + 32]
            x = torch.from_numpy(np.stack([augment(img, pts) for img, pts, _ in batch]))[:, None]
            y = torch.tensor([[label] for *_, label in batch], dtype=torch.float32)
            optimizer.zero_grad()
            loss_fn(model(x), y).backward()
            optimizer.step()
            schedule.step()
    return model.eval()


@torch.no_grad()
def predict(model, samples):
    x = torch.from_numpy(np.stack([to_tensor(align(img, pts)) for img, pts, _ in samples]))[:, None]
    return torch.sigmoid(model(x))[:, 0].numpy()


def main():
    raw = download()
    detector = mp.tasks.vision.FaceDetector.create_from_options(
        mp.tasks.vision.FaceDetectorOptions(base_options=mp.tasks.BaseOptions(model_asset_path=str(DETECTOR)))
    )

    people: dict[int, list] = {}
    missed = []
    for path in sorted(raw.glob("*.jpg")):
        image = Image.open(path).convert("RGB")
        points = eyes(detector, image)
        if points is None:
            missed.append(path.name)
            continue
        people.setdefault(int(path.stem[:-1]), []).append((image, points, 1.0 if path.stem.endswith("b") else 0.0))
    print(f"Faces found in {sum(map(len, people.values()))}/400 images" + (f", missed: {', '.join(missed)}" if missed else ""))

    ids = sorted(people)
    random.shuffle(ids)
    folds = [ids[i::5] for i in range(5)]
    accuracies = []
    for k, held_out in enumerate(folds):
        train_set = [s for p in ids if p not in held_out for s in people[p]]
        test_set = [s for p in held_out for s in people[p]]
        probs = predict(train(train_set), test_set)
        accuracy = float(np.mean((probs >= SPEC["smileThreshold"]) == np.array([s[2] for s in test_set])))
        accuracies.append(accuracy)
        print(f"Fold {k + 1}: {accuracy:.1%} on {len(held_out)} unseen people")
    mean = float(np.mean(accuracies))
    print(f"Cross-validated accuracy: {mean:.1%}")

    print("Training final model on everyone")
    everyone = [s for p in ids for s in people[p]]
    model = train(everyone)
    torch.onnx.export(
        model, torch.zeros(1, 1, SIZE, SIZE), MODELS / "smile.onnx", input_names=["input"], output_names=["logit"], opset_version=17, dynamo=False
    )
    (MODELS / "smile.json").write_text(
        json.dumps({"crossValidatedAccuracy": round(mean, 4), "folds": [round(a, 4) for a in accuracies], "trained": date.today().isoformat()}, indent=2) + "\n"
    )

    # Python's scores for a few images, so the browser pipeline can be checked against them.
    names = ["100a", "100b", "137a", "137b", "21a", "21b", "58a", "58b"]
    picks = [(n, s) for n in names for s in people.get(int(n[:-1]), []) if s[2] == (1.0 if n.endswith("b") else 0.0)]
    probs = predict(model, [s for _, s in picks])
    (ROOT / "scripts" / "check_samples.json").write_text(
        json.dumps({n: round(float(p), 4) for (n, _), p in zip(picks, probs)}, indent=2) + "\n"
    )
    print(f"Wrote {MODELS / 'smile.onnx'}")


if __name__ == "__main__":
    main()
