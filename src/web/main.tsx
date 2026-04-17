import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App.js";
import "./styles/globals.css";
import { ThemeProvider } from "./theme/ThemeProvider.js";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
