/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "@fontsource/open-sans/300.css"; // lighter weights are used on Linux
import "@fontsource/open-sans/300-italic.css"; // (WebKitGTK renders ~+100 heavier)
import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/400-italic.css";
import "@fontsource/open-sans/500.css";
import "@fontsource/open-sans/600.css";
import "@fontsource/open-sans/700.css";
import "katex/dist/katex.min.css";
import "./images"; // registers the markdown image-src resolver
import "./highlighter"; // registers the Shiki code highlighter + kicks off load
import "./styles/app.css";

render(() => <App />, document.getElementById("root")!);
