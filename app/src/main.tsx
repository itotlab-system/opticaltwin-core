import React from "react";
import ReactDOM from "react-dom/client";
import AuthGate from "./AuthGate";
import { SettingsProvider } from "./settings";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsProvider>
      <AuthGate />
    </SettingsProvider>
  </React.StrictMode>
);
