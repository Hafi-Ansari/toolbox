// Names and emojis people can pick for themselves (§6.1). The lists are copied from api/rooms.ts, as the
// spec asks: the server only accepts these emojis, and cleans names the same way.
import { SERVER } from "./tuning.ts";

export const ADJECTIVES = [
	"Amber",
	"Brisk",
	"Calm",
	"Daring",
	"Eager",
	"Fuzzy",
	"Gentle",
	"Hazy",
	"Jolly",
	"Keen",
	"Lucky",
	"Mellow",
	"Nimble",
	"Quiet",
	"Rapid",
	"Sunny",
	"Tidy",
	"Velvet",
	"Witty",
	"Zesty",
];

export const ANIMALS: [name: string, emoji: string][] = [
	["Otter", "🦦"],
	["Fox", "🦊"],
	["Owl", "🦉"],
	["Panda", "🐼"],
	["Koala", "🐨"],
	["Tiger", "🐯"],
	["Frog", "🐸"],
	["Penguin", "🐧"],
	["Octopus", "🐙"],
	["Turtle", "🐢"],
	["Hedgehog", "🦔"],
	["Whale", "🐳"],
	["Bee", "🐝"],
	["Crab", "🦀"],
	["Sloth", "🦥"],
	["Llama", "🦙"],
	["Parrot", "🦜"],
	["Rabbit", "🐰"],
	["Lion", "🦁"],
	["Seal", "🦭"],
];

export const EMOJIS = ANIMALS.map(([, e]) => e);

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

export function randomProfile(): { name: string; emoji: string } {
	const [animal, emoji] = pick(ANIMALS);
	return { name: `${pick(ADJECTIVES)} ${animal}`, emoji };
}

/** NFC, control and bidi characters removed, spaces collapsed, at most 24 characters. "" when nothing is left. */
export function cleanName(raw: string): string {
	const cleaned = raw
		.normalize("NFC")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
		.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return [...cleaned].slice(0, SERVER.nameMax).join("").trim();
}
