import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import LoginGate from "./components/LoginGate";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <LoginGate>
        <App />
      </LoginGate>
    </AuthProvider>
  </React.StrictMode>
);