import React from "react";
import { createRoot } from "react-dom/client";
import { CardHoverInfo } from "./components/CardHoverInfo.tsx";
import { App } from "./App.tsx";
import "./styles.css";
import "./components/table/table.css";
import "./theme.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <CardHoverInfo />
  </React.StrictMode>,
);
