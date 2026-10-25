// App-wide state: which API we talk to, who is signed in, and the cart (kept in localStorage between visits).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CartLine, StoreApi, User } from "./api/types";

interface Ctx {
  api: StoreApi;
  user: User | null;
  ready: boolean; // false until we know whether a saved session is still valid
  login(email: string, password: string): Promise<User>;
  logout(): void;
  cart: CartLine[];
  addToCart(productId: number, quantity?: number): void;
  setQuantity(productId: number, quantity: number): void;
  clearCart(): void;
}

const AppContext = createContext<Ctx | null>(null);
const CART_KEY = "store.cart";

function loadCart(): CartLine[] {
  try {
    const v = JSON.parse(localStorage.getItem(CART_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((l) => Number.isInteger(l?.productId) && Number.isInteger(l?.quantity) && l.quantity > 0) : [];
  } catch {
    return [];
  }
}

export function AppProvider({ api, initialCart, children }: { api: StoreApi; initialCart?: CartLine[]; children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [cart, setCart] = useState<CartLine[]>(() => initialCart ?? loadCart());

  useEffect(() => {
    let live = true;
    api.currentUser().then((u) => {
      if (live) {
        setUser(u);
        setReady(true);
      }
    });
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* private mode: the cart lasts for this tab only */
    }
  }, [cart]);

  const login = useCallback(
    async (email: string, password: string) => {
      const u = await api.login(email, password);
      setUser(u);
      return u;
    },
    [api],
  );
  const logout = useCallback(() => {
    api.logout();
    setUser(null);
  }, [api]);
  const addToCart = useCallback((productId: number, quantity = 1) => {
    setCart((c) => {
      const line = c.find((l) => l.productId === productId);
      if (line) return c.map((l) => (l.productId === productId ? { ...l, quantity: Math.min(20, l.quantity + quantity) } : l));
      return [...c, { productId, quantity }];
    });
  }, []);
  const setQuantity = useCallback((productId: number, quantity: number) => {
    setCart((c) => (quantity <= 0 ? c.filter((l) => l.productId !== productId) : c.map((l) => (l.productId === productId ? { ...l, quantity: Math.min(20, quantity) } : l))));
  }, []);
  const clearCart = useCallback(() => setCart([]), []);

  const value = useMemo(
    () => ({ api, user, ready, login, logout, cart, addToCart, setQuantity, clearCart }),
    [api, user, ready, login, logout, cart, addToCart, setQuantity, clearCart],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

/** Loads data for a page: { data, error, loading, reload }. Ignores answers that arrive after the page changed. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (e: Error) => live && setState({ error: e.message || "Something went wrong.", loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}
