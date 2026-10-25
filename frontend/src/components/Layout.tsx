// Top bar with navigation (different for customers and the merchant), the demo-mode banner, and the page outlet.

import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useApp } from "../state";

export function Layout() {
  const { api, user, logout, cart } = useApp();
  const navigate = useNavigate();
  const count = cart.reduce((s, l) => s + l.quantity, 0);
  const merchant = user?.role === "merchant";

  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-in">
          <NavLink to="/" className="brand-link">
            <span className="logo" aria-hidden="true">
              ◆
            </span>
            <span className="shop">Campus Store</span>
          </NavLink>
          <nav aria-label="Main" className="nav">
            {merchant ? (
              <>
                <NavLink to="/merchant" end>
                  Dashboard
                </NavLink>
                <NavLink to="/merchant/payments">Payments</NavLink>
                <NavLink to="/merchant/webhooks">Webhooks</NavLink>
              </>
            ) : (
              <>
                <NavLink to="/" end>
                  Shop
                </NavLink>
                {user && <NavLink to="/orders">My orders</NavLink>}
                <NavLink to="/cart">
                  Cart{count > 0 && <span className="badge" aria-label={`${count} items`}>{count}</span>}
                </NavLink>
              </>
            )}
          </nav>
          <div className="who">
            {user ? (
              <>
                <span className="muted-light">{user.name}</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    logout();
                    navigate("/");
                  }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <NavLink to="/login">Sign in</NavLink>
            )}
          </div>
        </div>
      </header>
      {api.mode === "demo" && (
        <p className="demo-banner" role="note">
          Demo mode: everything runs in your browser with a simulated gateway and simulated history. No real payments. The full
          platform (FastAPI + Postgres) is in the <a href="https://github.com/30-Saumya-11/secure-checkout">repository</a>.
        </p>
      )}
      <main className="page" id="main">
        <Outlet />
      </main>
    </>
  );
}
