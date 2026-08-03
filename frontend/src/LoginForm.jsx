import React, { useState } from "react";
import { login as loginRequest } from "./api/stenogramaApi";

/**
 * PRISIJUNGIMO FORMA (#18 PR4).
 *
 * Atskiras komponentas, ne dalis `App.jsx`: prisijungimas yra vienintelis
 * ekranas, kuris rodomas BE tapatybės, tad jo būsena su likusia programa
 * nesusijusi.
 *
 * ⚠️ Ši forma yra PATOGUMAS, ne apsauga. Backend tikrina kiekvieną užklausą
 * nepriklausomai nuo to, ką rodo UI – žr. `middleware/authorize.js`.
 */
export default function LoginForm({ onSuccess, sessionExpired }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);

    try {
      const user = await loginRequest(username, password);
      onSuccess(user);
    } catch (err) {
      /**
       * Pranešimas ateina iš backend'o ir yra VIENODAS nežinomam vartotojui
       * bei neteisingam slaptažodžiui – UI to skirtumo nesukuria ir neturi.
       */
      setError(err.message || "Prisijungti nepavyko.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#F7F4EE",
        padding: "1rem",
      }}
    >
      <form
        onSubmit={handleSubmit}
        aria-labelledby="login-title"
        style={{
          width: "100%",
          maxWidth: "22rem",
          background: "#FFFFFF",
          border: "1px solid #E2DACE",
          borderRadius: "0.5rem",
          padding: "1.5rem",
        }}
      >
        <h1 id="login-title" style={{ fontSize: "1.25rem", marginBottom: "0.25rem", color: "#33302B" }}>
          Stenograma
        </h1>
        <p style={{ fontSize: "0.85rem", color: "#6B6459", marginBottom: "1.25rem" }}>
          Prisijunkite, kad tęstumėte.
        </p>

        {sessionExpired && (
          /**
           * SESIJA PASIBAIGĖ ≠ NETEISINGI DUOMENYS.
           *
           * Be šio pranešimo vartotojas, kurį išmetė po 30 min neaktyvumo,
           * matytų tuščią prisijungimo formą ir manytų, kad kažką sulaužė.
           */
          <div
            role="status"
            style={{
              background: "#FBF3E4",
              border: "1px solid #E8D9B8",
              borderRadius: "0.375rem",
              padding: "0.6rem 0.75rem",
              marginBottom: "1rem",
              fontSize: "0.85rem",
              color: "#6B5A34",
            }}
          >
            Sesija pasibaigė. Prisijunkite iš naujo.
          </div>
        )}

        <label htmlFor="login-username" style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem" }}>
          Vartotojo vardas
        </label>
        <input
          id="login-username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          style={{
            width: "100%",
            padding: "0.5rem",
            marginBottom: "0.9rem",
            border: "1px solid #D9D0C2",
            borderRadius: "0.375rem",
          }}
        />

        <label htmlFor="login-password" style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem" }}>
          Slaptažodis
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{
            width: "100%",
            padding: "0.5rem",
            marginBottom: "1.1rem",
            border: "1px solid #D9D0C2",
            borderRadius: "0.375rem",
          }}
        />

        {error && (
          <div
            role="alert"
            style={{
              background: "#FBEDEA",
              border: "1px solid #E8C4BC",
              borderRadius: "0.375rem",
              padding: "0.6rem 0.75rem",
              marginBottom: "1rem",
              fontSize: "0.85rem",
              color: "#8A3B2A",
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          style={{
            width: "100%",
            padding: "0.6rem",
            background: busy ? "#B9AFA0" : "#33302B",
            color: "#FFFFFF",
            border: "none",
            borderRadius: "0.375rem",
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Jungiamasi…" : "Prisijungti"}
        </button>
      </form>
    </div>
  );
}
