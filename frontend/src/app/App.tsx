import './App.css';
import { useEffect, useState } from 'react';

import { AppNavbar } from "@shared/components/AppNavbar";
import { EmergencyDeactivatedModal } from "@shared/components/EmergencyDeactivatedModal";
import { routes } from './router';

function getHashPath(): string {
  const rawPath = window.location.hash.replace(/^#/, '').replace(/\/+$/, '') || '/';
  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}

export function App() {
  const [currentPath, setCurrentPath] = useState<string>(getHashPath);

  useEffect(() => {
    const syncPath = () => {
      setCurrentPath(getHashPath());
    };

    window.addEventListener('hashchange', syncPath);
    window.addEventListener('popstate', syncPath);

    // Ensure initial path is normalized, including first load on GitHub Pages.
    syncPath();

    return () => {
      window.removeEventListener('hashchange', syncPath);
      window.removeEventListener('popstate', syncPath);
    };
  }, []);

  useEffect(() => {
    const matchedRoute = routes.find((route) => route.path === currentPath);
    if (!matchedRoute?.redirectTo) {
      return;
    }

    if (matchedRoute.redirectTo !== currentPath) {
      window.location.hash = matchedRoute.redirectTo;
    }
  }, [currentPath]);

  const activeRoute = routes.find((route) => route.path === currentPath) ?? routes[0];

  if (activeRoute.redirectTo) {
    return (
      <div className="app-shell">
        <AppNavbar />
        <EmergencyDeactivatedModal />
      </div>
    );
  }

  const ActivePage = activeRoute.element;

  return (
    <div className="app-shell">
      <AppNavbar />
      <ActivePage />
      <EmergencyDeactivatedModal />
    </div>
  );
}

