/**
 * A curated subset of GitHub/Slack-style emoji shortcodes. Used by the renderer
 * to turn `:smile:` into a glyph and (later) by the autocomplete popup. Kept
 * deliberately small — the common set covers everyday writing without shipping
 * the full ~1800-entry table.
 */
export const EMOJI: Record<string, string> = {
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

/** Look up a shortcode (without the surrounding colons). */
export function emojiFor(name: string): string | undefined {
  return EMOJI[name];
}

/** Shortcodes whose name starts with `prefix` (for autocomplete), capped. */
export function emojiMatches(prefix: string, limit = 8): { name: string; glyph: string }[] {
  const p = prefix.toLowerCase();
  const out: { name: string; glyph: string }[] = [];
  for (const name in EMOJI) {
    if (name.startsWith(p)) {
      out.push({ name, glyph: EMOJI[name] });
      if (out.length >= limit) break;
    }
  }
  return out;
}
