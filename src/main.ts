import "./style.css";
import { createApp } from "./App";

const init = async () => {
  const app = await createApp();
  document.querySelector("#app")?.appendChild(app);
};

init().catch((err) => {
  console.error("Failed to initialize app", err);
  const el = document.createElement("div");
  el.className = "error";
  el.textContent = err instanceof Error ? err.message : "Unknown error";
  document.querySelector("#app")?.appendChild(el);
});
