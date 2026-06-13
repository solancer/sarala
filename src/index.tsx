/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/400-italic.css";
import "@fontsource/open-sans/600.css";
import "@fontsource/open-sans/700.css";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import "./images"; // registers the markdown image-src resolver
import "./styles/app.css";

render(() => <App />, document.getElementById("root")!);
