/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "@fontsource/inter/400.css";
import "@fontsource/inter/400-italic.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "katex/dist/katex.min.css";
import "./images"; // registers the markdown image-src resolver
import "./highlighter"; // registers the Shiki code highlighter + kicks off load
import "./styles/app.css";

render(() => <App />, document.getElementById("root")!);
