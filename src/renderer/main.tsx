import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { api } from "./api";
import "./style.css";
import { applyTheme, readTheme } from "./theme";

applyTheme(readTheme());

function DesktopApp() {
  useEffect(() => {
    if (!api.mobile) void invoke("show_main_window").catch(console.error);
  }, []);
  return <App api={api} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
