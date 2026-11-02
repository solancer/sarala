/**
 * The web build's entry. The order is the point: the platform is installed
 * before the app's modules load, because some of them (the menu tree) read it
 * as they evaluate.
 */
import { installWebPlatform } from "../../src/platform";
import { setVoiceBackend } from "../../src/voice/transport";
import { platform } from "./platform";
import { webVoiceBackend } from "./voice/backend";
import "@fontsource-variable/literata/opsz.css";
import "@fontsource-variable/literata/opsz-italic.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "./web.css";
import "./design.css";

installWebPlatform(platform);
setVoiceBackend(webVoiceBackend());
void import("./components/toolbar").then(({ toolbar }) => {
  platform.toolbar = toolbar;
  return import("../../src/index");
});
