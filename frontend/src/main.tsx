import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* hash URLs (#/merchant) work on static hosting like GitHub Pages, where /merchant would be a 404 */}
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
