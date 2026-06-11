/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "highlight.js/styles/github.css";
import "./styles/app.css";

render(() => <App />, document.getElementById("root")!);
