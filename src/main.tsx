import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./app/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
