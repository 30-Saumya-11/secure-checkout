// Routes. The router itself is chosen in main.tsx (HashRouter, so refreshes work on GitHub Pages).

import { useMemo, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { createApi } from "./api";
import type { CartLine, Role, StoreApi } from "./api/types";
import { Layout } from "./components/Layout";
import { CheckoutPage } from "./pages/CheckoutPage";
import { CartPage, Loading, LoginPage, OrderPage, OrdersPage, StorePage } from "./pages/customer";
import { DashboardPage, PaymentDetailPage, PaymentsPage, WebhooksPage } from "./pages/merchant";
import { AppProvider, useApp } from "./state";

function RequireRole({ role, children }: { role?: Role; children: ReactNode }) {
  const { user, ready } = useApp();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (role && user.role !== role) {
    return (
      <div className="card error-card" role="alert">
        <p>{role === "merchant" ? "This page is for the store's merchant account." : "This page is for customers."}</p>
      </div>
    );
  }
  return <>{children}</>;
}

interface Props {
  api?: StoreApi; // tests pass their own
  initialCart?: CartLine[];
  retryDelayMs?: number;
}

export default function App({ api, initialCart, retryDelayMs }: Props) {
  const store = useMemo(() => api ?? createApi(), [api]);
  return (
    <AppProvider api={store} initialCart={initialCart}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<StorePage />} />
          <Route path="cart" element={<CartPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route
            path="checkout"
            element={
              <RequireRole role="customer">
                <CheckoutPage retryDelayMs={retryDelayMs} />
              </RequireRole>
            }
          />
          <Route path="orders" element={<RequireRole role="customer"><OrdersPage /></RequireRole>} />
          <Route path="orders/:id" element={<RequireRole><OrderPage /></RequireRole>} />
          <Route path="merchant" element={<RequireRole role="merchant"><DashboardPage /></RequireRole>} />
          <Route path="merchant/payments" element={<RequireRole role="merchant"><PaymentsPage /></RequireRole>} />
          <Route path="merchant/payments/:id" element={<RequireRole role="merchant"><PaymentDetailPage /></RequireRole>} />
          <Route path="merchant/webhooks" element={<RequireRole role="merchant"><WebhooksPage /></RequireRole>} />
          <Route path="*" element={<p className="card">Page not found.</p>} />
        </Route>
      </Routes>
    </AppProvider>
  );
}
