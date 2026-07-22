import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

import { DriverAuthUser, getPresetDriverAccounts, loginDriver, signupDriver } from '../utils/driverAuthApi';
import {
  getPresetHospitalAccounts,
  HospitalAuthUser,
  loginHospital,
  signupHospital,
} from '../utils/hospitalAuthApi';

const HOSPITAL_AUTH_STORAGE_KEY = 'codered-hospital-auth-v2';
const DRIVER_AUTH_STORAGE_KEY = 'codered-driver-auth-v2';
const FALLBACK_PRESET_EMAILS = [
  'apollo.er@codered.ai',
  'lilavati.er@codered.ai',
  'fortis.er@codered.ai',
  'kokilaben.er@codered.ai',
  'nanavati.er@codered.ai',
  'rubyhall.er@codered.ai',
];
const FALLBACK_DRIVER_EMAILS = [
  'driver.rajesh@codered.ai',
  'driver.vikram@codered.ai',
  'driver.amit@codered.ai',
  'driver.suresh@codered.ai',
  'driver.priya@codered.ai',
  'driver.rohit@codered.ai',
];

interface StoredAuthSession<TUser> {
  token: string;
  user: TUser;
}

interface AuthContextValue {
  hospitalUser: HospitalAuthUser | null;
  isHospitalAuthenticated: boolean;
  hospitalToken: string | null;
  defaultHospitalPassword: string;
  presetHospitalEmails: string[];
  loginHospitalUser: (email: string, password: string) => Promise<void>;
  signupHospitalUser: (
    hospitalId: string,
    email: string,
    password: string,
    location: { lat: number; lng: number },
    bedCapacity: number,
  ) => Promise<void>;
  logoutHospitalUser: () => void;
  driverUser: DriverAuthUser | null;
  isDriverAuthenticated: boolean;
  driverToken: string | null;
  defaultDriverPassword: string;
  presetDriverEmails: string[];
  loginDriverUser: (email: string, password: string) => Promise<void>;
  signupDriverUser: (
    driverName: string,
    email: string,
    password: string,
    phone: string,
    vehicleNumber: string,
    linkedHospitalId: string,
  ) => Promise<void>;
  logoutDriverUser: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  hospitalUser: null,
  isHospitalAuthenticated: false,
  hospitalToken: null,
  defaultHospitalPassword: 'Password@123',
  presetHospitalEmails: FALLBACK_PRESET_EMAILS,
  loginHospitalUser: async () => {
    throw new Error('Auth provider is not ready.');
  },
  signupHospitalUser: async () => {
    throw new Error('Auth provider is not ready.');
  },
  logoutHospitalUser: () => {
    // no-op fallback
  },
  driverUser: null,
  isDriverAuthenticated: false,
  driverToken: null,
  defaultDriverPassword: 'Password@123',
  presetDriverEmails: FALLBACK_DRIVER_EMAILS,
  loginDriverUser: async () => {
    throw new Error('Auth provider is not ready.');
  },
  signupDriverUser: async () => {
    throw new Error('Auth provider is not ready.');
  },
  logoutDriverUser: () => {
    // no-op fallback
  },
});

function isHospitalAuthUser(candidate: unknown): candidate is HospitalAuthUser {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const value = candidate as Partial<HospitalAuthUser>;

  return Boolean(typeof value.id === 'string' && typeof value.name === 'string' && typeof value.email === 'string');
}

function isStoredHospitalSession(candidate: unknown): candidate is StoredAuthSession<HospitalAuthUser> {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const value = candidate as Partial<StoredAuthSession<HospitalAuthUser>>;

  return Boolean(typeof value.token === 'string' && isHospitalAuthUser(value.user));
}

function loadStoredHospitalSession(): StoredAuthSession<HospitalAuthUser> | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(HOSPITAL_AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isStoredHospitalSession(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function isDriverAuthUser(candidate: unknown): candidate is DriverAuthUser {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const value = candidate as Partial<DriverAuthUser>;

  return Boolean(typeof value.id === 'string' && typeof value.name === 'string' && typeof value.email === 'string');
}

function isStoredDriverSession(candidate: unknown): candidate is StoredAuthSession<DriverAuthUser> {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const value = candidate as Partial<StoredAuthSession<DriverAuthUser>>;

  return Boolean(typeof value.token === 'string' && isDriverAuthUser(value.user));
}

function loadStoredDriverSession(): StoredAuthSession<DriverAuthUser> | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(DRIVER_AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isStoredDriverSession(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [hospitalSession, setHospitalSession] = useState<StoredAuthSession<HospitalAuthUser> | null>(
    loadStoredHospitalSession,
  );
  const [driverSession, setDriverSession] = useState<StoredAuthSession<DriverAuthUser> | null>(
    loadStoredDriverSession,
  );
  const [presetHospitalEmails, setPresetHospitalEmails] = useState<string[]>(FALLBACK_PRESET_EMAILS);
  const [presetDriverEmails, setPresetDriverEmails] = useState<string[]>(FALLBACK_DRIVER_EMAILS);
  const [defaultHospitalPassword, setDefaultHospitalPassword] = useState('Password@123');
  const [defaultDriverPassword, setDefaultDriverPassword] = useState('Password@123');

  const hospitalUser = hospitalSession?.user ?? null;
  const hospitalToken = hospitalSession?.token ?? null;
  const driverUser = driverSession?.user ?? null;
  const driverToken = driverSession?.token ?? null;

  useEffect(() => {
    let isMounted = true;

    void getPresetHospitalAccounts()
      .then((data) => {
        if (!isMounted) {
          return;
        }

        if (data.emails.length > 0) {
          setPresetHospitalEmails(data.emails);
        }

        if (data.defaultPassword) {
          setDefaultHospitalPassword(data.defaultPassword);
        }
      })
      .catch(() => {
        // Keep fallback values when backend is temporarily unavailable.
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    void getPresetDriverAccounts()
      .then((data) => {
        if (!isMounted) {
          return;
        }

        if (data.emails.length > 0) {
          setPresetDriverEmails(data.emails);
        }

        if (data.defaultPassword) {
          setDefaultDriverPassword(data.defaultPassword);
        }
      })
      .catch(() => {
        // Keep fallback values when backend is temporarily unavailable.
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!hospitalSession) {
      window.localStorage.removeItem(HOSPITAL_AUTH_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(HOSPITAL_AUTH_STORAGE_KEY, JSON.stringify(hospitalSession));
  }, [hospitalSession]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!driverSession) {
      window.localStorage.removeItem(DRIVER_AUTH_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(DRIVER_AUTH_STORAGE_KEY, JSON.stringify(driverSession));
  }, [driverSession]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (!event.key) {
        return;
      }

      if (event.key === HOSPITAL_AUTH_STORAGE_KEY) {
        setHospitalSession(loadStoredHospitalSession());
      }

      if (event.key === DRIVER_AUTH_STORAGE_KEY) {
        setDriverSession(loadStoredDriverSession());
      }
    };

    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  async function loginHospitalUser(email: string, password: string) {
    const session = await loginHospital({ email, password });
    setHospitalSession(session);
  }

  async function signupHospitalUser(
    hospitalId: string,
    email: string,
    password: string,
    location: { lat: number; lng: number },
    bedCapacity: number,
  ) {
    const session = await signupHospital({ hospitalId, email, password, location, bedCapacity });
    setHospitalSession(session);
  }

  function logoutHospitalUser() {
    setHospitalSession(null);
  }

  async function loginDriverUser(email: string, password: string) {
    const session = await loginDriver({ email, password });
    setDriverSession(session);
  }

  async function signupDriverUser(
    driverName: string,
    email: string,
    password: string,
    phone: string,
    vehicleNumber: string,
    linkedHospitalId: string,
  ) {
    const session = await signupDriver({
      driverName,
      email,
      password,
      phone,
      vehicleNumber,
      linkedHospitalId,
    });
    setDriverSession(session);
  }

  function logoutDriverUser() {
    setDriverSession(null);
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      hospitalUser,
      isHospitalAuthenticated: Boolean(hospitalUser),
      hospitalToken,
      defaultHospitalPassword,
      presetHospitalEmails,
      loginHospitalUser,
      signupHospitalUser,
      logoutHospitalUser,
      driverUser,
      isDriverAuthenticated: Boolean(driverUser),
      driverToken,
      defaultDriverPassword,
      presetDriverEmails,
      loginDriverUser,
      signupDriverUser,
      logoutDriverUser,
    }),
    [
      hospitalUser,
      hospitalToken,
      defaultHospitalPassword,
      presetHospitalEmails,
      driverUser,
      driverToken,
      defaultDriverPassword,
      presetDriverEmails,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useHospitalAuth() {
  return useContext(AuthContext);
}
