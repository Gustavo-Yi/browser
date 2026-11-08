import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { AppearanceProvider } from "./Appearance.jsx";
import "./styles.css";
import "./appearance.css";
import "./desktop.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppearanceProvider><App /></AppearanceProvider>
  </React.StrictMode>,
);
