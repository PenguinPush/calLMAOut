// Obvious laughs skip the network entirely.
const LAUGH =
  /\b(?:l+o+l+(?:o+l+)*[sz]*|l+m+f*a+o+|l+m+f*o+a+|l+a+m+f*o+|rofl|b+w*a+h+a+\w*|i\s+(?:just\s+|literally\s+)?laughed)\b|\b(?:a*h+a+){2,}h*\b|\b(?:h+e+){2,}\b|[\u{1F602}\u{1F923}\u{1F480}\u{1F639}]/iu;

// Keyboard mashes like BHWHFAH or hshshshs: no real word is over 40% h's.
function isLaughMash(word: string) {
  return word.length >= 5 && (word.match(/h/gi)?.length ?? 0) / word.length > 0.4;
}

export function looksLikeLaugh(text: string) {
  return LAUGH.test(text) || (text.match(/[a-z]+/gi) ?? []).some(isLaughMash);
}

// Asks Jev (TypeSafe System One) whether the message expresses laughing.
// Returns the probability of yes, 0..1.
export async function jevLaughProbability(text: string, apiKey: string, signal?: AbortSignal) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal,
    body: JSON.stringify({
      model: "jev-latest",
      state: text,
      questions: {
        laughed: {
          type: "noul",
          instructions:
            "Is the writer of this chat message laughing, amused, or reacting to something as funny in any way, including slang, emoji, or keyboard spam?",
          criteria: {
            true: {
              what: "Any sign the writer laughed or found something funny, even if indirect, ironic, or mixed with other words",
              classic: "lol, lmao, lmfao, rofl, haha, hehe, ahaha, 'i laughed', 'i'm laughing', 'that's hilarious', 'so funny'",
              keyboard_spam:
                "Random letter mashing from laughing too hard, often all caps and full of h's, a's, s's, j's and k's: asdfghjkl, akdjfkajsd, sjdhfkjs, HSDJFKSJ, BHWHFAH, HWAHHAHFH, BAHAHSHHA, AHSHAHSHS, hshshshs, ajsjsjsj, skskskssk, jajaja, kkkkk, wkwkwk, 555, xD, XDDD",
              misspellings:
                "Typos, stretched, or mangled versions of laughs count the same as the real word: lmaoo, lmaooooo, lamo, lmoa, lmfoa, lamfo, loll, lolol, lolz, lul, lel, hahah, hahahahah, hahsha, ahahshah, bahaha, bwahaha, bwhahaha, hehe, heheh, jsjsjs, ded, ddead, imdeadd, crine, cryinggg, screamingggg, STOPPPP, i cnat, i cant breath",
              gen_z:
                "i'm dead, ded, i'm crying, crying, i can't, i can't breathe, i'm weak, i'm screaming, screaming, sobbing, i'm wheezing, wheeze, 'stop', 'STOPPP', 'not the ___', 'the ___ 😭', 'bro 😭', 'nah 💀', 'this sent me', 'i'm deceased', 'i'm on the floor', 'rolling', 'i'm losing it', 'help', 'LMFAOOO', 'ong 😭', 'that's crazy 💀', 'i fell', 'i choked', 'why is this so real', 'pls', 'icl i'm cackling', 'cackling', 'giggling', 'kicking my feet'",
              emoji: "😂 🤣 💀 😭 (when reacting to something funny) ☠️ 😹 😆 🫠 🤭 😩",
            },
            false:
              "No laughter or amusement: neutral info, plans, questions, genuine sadness or anger, or only describing someone else laughing",
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Number(data.answers?.laughed?.noul ?? 0);
}
