import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./api";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App api={api} />
  </React.StrictMode>,
);
