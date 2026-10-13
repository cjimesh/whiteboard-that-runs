/**
 * Entry point.
 *
 * Mounts the app and nothing else. The build test opens the shipped file in a
 * real browser with every non-`file://` request blocked and waits for a
 * `data-surface` element, so the zero-egress proof needs something rendered by
 * script to wait on.
 */
import "./style.css";
import { mountApp } from "./ui/app.ts";

const app = document.querySelector<HTMLDivElement>("#app");
if (app !== null) {
  mountApp(app);
}
