import { UNICODE_EMOJI } from "./data/unicode-emoji";
import { EMOJI_CATALOG } from "./data/emoji-catalog";

/** Full bundled catalog plus established Sarala aliases. No runtime requests. */
export const EMOJI: Record<string, string> = {
  ...EMOJI_CATALOG,
  ...UNICODE_EMOJI,
  smile: "😄", smiley: "😃", grin: "😁", laughing: "😆", joy: "😂",
  rofl: "🤣", blush: "😊", wink: "😉", heart_eyes: "😍", kissing_heart: "😘",
  thinking: "🤔", neutral_face: "😐", expressionless: "😑", unamused: "😒",
  sweat_smile: "😅", sob: "😭", cry: "😢", angry: "😠", rage: "😡",
  sunglasses: "😎", nerd_face: "🤓", scream: "😱",
  flushed: "😳", relieved: "😌", yum: "😋", stuck_out_tongue: "😛",
  sleeping: "😴", dizzy_face: "😵", mask: "😷", smirk: "😏", confused: "😕",
  worried: "😟", frowning: "😦", open_mouth: "😮", astonished: "😲",
  thumbsup: "👍", "+1": "👍", thumbsdown: "👎", "-1": "👎", ok_hand: "👌",
  clap: "👏", raised_hands: "🙌", pray: "🙏", muscle: "💪", point_right: "👉",
  point_left: "👈", point_up: "☝️", point_down: "👇", wave: "👋", fist: "✊",
  v: "✌️", handshake: "🤝", writing_hand: "✍️",
  heart: "❤️", broken_heart: "💔", two_hearts: "💕", sparkling_heart: "💖",
  blue_heart: "💙", green_heart: "💚", yellow_heart: "💛", purple_heart: "💜",
  fire: "🔥", star: "⭐", star2: "🌟", sparkles: "✨", zap: "⚡", boom: "💥",
  tada: "🎉", confetti_ball: "🎊", balloon: "🎈", gift: "🎁", trophy: "🏆",
  medal: "🏅", crown: "👑", rocket: "🚀", airplane: "✈️", car: "🚗",
  bulb: "💡", book: "📖", books: "📚", pencil: "📝", memo: "📝",
  computer: "💻", desktop: "🖥️", iphone: "📱", email: "📧", envelope: "✉️",
  calendar: "📅", clock: "🕐", hourglass: "⌛", alarm_clock: "⏰",
  warning: "⚠️", no_entry: "⛔", x: "❌", heavy_check_mark: "✔️",
  white_check_mark: "✅", ballot_box_with_check: "☑️", question: "❓",
  exclamation: "❗", bell: "🔔", lock: "🔒", unlock: "🔓", key: "🔑",
  mag: "🔍", link: "🔗", paperclip: "📎", pushpin: "📌", bookmark: "🔖",
  chart_with_upwards_trend: "📈", chart_with_downwards_trend: "📉",
  bar_chart: "📊", clipboard: "📋", page_facing_up: "📄", file_folder: "📁",
  hammer: "🔨", wrench: "🔧", gear: "⚙️", nut_and_bolt: "🔩", bug: "🐛",
  package: "📦", inbox_tray: "📥", outbox_tray: "📤", recycle: "♻️",
  coffee: "☕", beer: "🍺", pizza: "🍕", hamburger: "🍔", cake: "🍰",
  apple: "🍎", checkered_flag: "🏁", soccer: "⚽", earth_americas: "🌎",
  sun: "☀️", sunny: "☀️", moon: "🌙", cloud: "☁️", rainbow: "🌈",
  snowflake: "❄️", droplet: "💧", ocean: "🌊", seedling: "🌱", deciduous_tree: "🌳",
  cat: "🐱", dog: "🐶", mouse: "🐭", rabbit: "🐰", bear: "🐻", panda_face: "🐼",
  ghost: "👻", alien: "👽", robot: "🤖", skull: "💀", poop: "💩", "100": "💯",
  eyes: "👀", speech_balloon: "💬", thought_balloon: "💭", zzz: "💤",
  hand: "✋", raising_hand: "🙋", shrug: "🤷", facepalm: "🤦",
};

const EMOJI_NAMES = Object.keys(EMOJI).sort();

/** Look up a shortcode (without the surrounding colons). */
export function emojiFor(name: string): string | undefined {
  return Object.hasOwn(EMOJI, name) ? EMOJI[name] : undefined;
}

/** Shortcodes whose name starts with `prefix` (for autocomplete), capped. */
export function emojiMatches(prefix: string, limit = 8): { name: string; glyph: string }[] {
  const p = prefix.toLowerCase();
  const out: { name: string; glyph: string }[] = [];
  if (limit <= 0) return out;
  for (const name of EMOJI_NAMES) {
    if (name.startsWith(p)) {
      out.push({ name, glyph: EMOJI[name] });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Unicode aliases in the catalog include accented names and punctuation. */
export const EMOJI_NAME = "[\\p{L}\\p{N}_+!#&()*.’-]+";
export const emojiShortcode = () => new RegExp(`:(${EMOJI_NAME}):`, "u");
