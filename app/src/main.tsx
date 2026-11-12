import "@fontsource/be-vietnam-pro/400.css";
import "@fontsource/be-vietnam-pro/500.css";
import "@fontsource/be-vietnam-pro/600.css";
import "@fontsource/be-vietnam-pro/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: false, refetchOnWindowFocus: false },
  },
});

// Chặn menu chuột phải mặc định của WebView (app có menu riêng), trừ trong ô nhập liệu.
window.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement;
  if (!el.closest("input, textarea")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
