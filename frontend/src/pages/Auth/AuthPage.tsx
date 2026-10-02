import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Sparkles, ArrowRight, Shield, AlertCircle } from 'lucide-react';

import { useHospitalAuth } from '@shared/providers/AuthContext';
import { loginAdmin, signupAdmin } from '@shared/utils/adminAuthApi';
import {
  type AppRole,
  clearAdminAuthUnlock,
  clearStoredAdminSession,
  dashboardPathByRole,
  hasAdminAuthUnlock,
  normalizeAppPath,
  persistAdminSession,
  readStoredAdminSession,
  redirectToPath,
  resolveAuthenticatedRole,
} from '@/utils/redirectByRole';
import './AuthPage.css';

type AuthMode = 'login' | 'signup';

interface RoleConfig {
  label: string;
  subtitle: string;
  emailPlaceholder: string;
}

const ROLE_CONFIG: Record<AppRole, RoleConfig> = {
  hospital: {
    label: 'Hospital',
    subtitle: 'Manage emergency intake and live ambulance dispatch from your hospital command dashboard.',
    emailPlaceholder: 'apollo.er@codered.ai',
  },
  driver: {
    label: 'Driver',
    subtitle: 'Access live dispatch missions, turn-by-turn guidance, and triage status in real time.',
    emailPlaceholder: 'driver.rajesh@codered.ai',
  },
  admin: {
    label: 'Admin',
    subtitle: 'Secure operations oversight with full fleet verification and system controls.',
    emailPlaceholder: 'admin.ops@codered.ai',
  },
};

const ADMIN_DEFAULT_PASSWORD = 'Admin@123';
const PUBLIC_AUTH_ROLES: AppRole[] = ['hospital', 'driver'];

function getCurrentHashPath(): string {
  if (typeof window === 'undefined') {
    return '/';
  }
  return normalizeAppPath(window.location.hash.replace(/^#/, '') || '/');
}

export function AuthPage() {
  const {
    defaultHospitalPassword,
    defaultDriverPassword,
    driverUser,
    hospitalUser,
    isDriverAuthenticated,
    isHospitalAuthenticated,
    loginDriverUser,
    loginHospitalUser,
    logoutDriverUser,
    logoutHospitalUser,
    presetDriverEmails,
    presetHospitalEmails,
    signupDriverUser,
    signupHospitalUser,
  } = useHospitalAuth();

  const currentPath = getCurrentHashPath();
  const isAdminSecretRoute = currentPath === '/admin/auth' || currentPath === '/admin/login';
  const allowedRoles = isAdminSecretRoute ? (['admin'] as AppRole[]) : PUBLIC_AUTH_ROLES;

  const [selectedRole, setSelectedRole] = useState<AppRole>(isAdminSecretRoute ? 'admin' : 'hospital');
  const [mode, setMode] = useState<AuthMode>('login');
  const [nameOrId, setNameOrId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDemoSubmitting, setIsDemoSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeRoleConfig = ROLE_CONFIG[selectedRole];

  const setExclusiveSessionForRole = useCallback(
    (role: AppRole) => {
      if (role !== 'hospital') logoutHospitalUser();
      if (role !== 'driver') logoutDriverUser();
      if (role !== 'admin') clearStoredAdminSession();
    },
    [logoutDriverUser, logoutHospitalUser],
  );

  useEffect(() => {
    if (isAdminSecretRoute) return;

    const authenticatedRole = resolveAuthenticatedRole({
      isHospitalAuthenticated: Boolean(isHospitalAuthenticated && hospitalUser),
      isDriverAuthenticated: Boolean(isDriverAuthenticated && driverUser),
      hasAdminSession: Boolean(readStoredAdminSession()),
    });

    if (authenticatedRole) {
      redirectToPath(dashboardPathByRole(authenticatedRole));
    }
  }, [driverUser, hospitalUser, isAdminSecretRoute, isDriverAuthenticated, isHospitalAuthenticated]);

  useEffect(() => {
    if (!isAdminSecretRoute) {
      clearAdminAuthUnlock();
      if (selectedRole === 'admin') {
        setSelectedRole('hospital');
      }
      return;
    }

    if (!hasAdminAuthUnlock()) {
      redirectToPath('/auth');
      return;
    }

    if (selectedRole !== 'admin') {
      setSelectedRole('admin');
    }

    if (mode !== 'login') {
      setMode('login');
    }
  }, [isAdminSecretRoute, mode, selectedRole]);

  // Reset form inputs when switching role or mode
  useEffect(() => {
    setErrorMessage(null);
    setNameOrId('');
    setEmail('');
    setPassword('');
    setShowPassword(false);
  }, [selectedRole, mode]);

  // 1-Click Demo Login Handler
  const handleDemoLogin = async () => {
    setIsDemoSubmitting(true);
    setErrorMessage(null);

    try {
      if (selectedRole === 'hospital') {
        const demoEmail = presetHospitalEmails[0] || 'apollo.er@codered.ai';
        const demoPassword = defaultHospitalPassword || 'Password@123';
        await loginHospitalUser(demoEmail, demoPassword);
      } else if (selectedRole === 'driver') {
        const demoEmail = presetDriverEmails[0] || 'driver.rajesh@codered.ai';
        const demoPassword = defaultDriverPassword || 'Password@123';
        await loginDriverUser(demoEmail, demoPassword);
      } else {
        const demoEmail = 'admin.ops@codered.ai';
        const demoPassword = ADMIN_DEFAULT_PASSWORD;
        const session = await loginAdmin({ email: demoEmail, password: demoPassword });
        persistAdminSession({
          token: session.token,
          user: {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
            role: session.user.role,
          },
        });
      }

      setExclusiveSessionForRole(selectedRole);
      redirectToPath(dashboardPathByRole(selectedRole));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Demo login failed. Please try again.');
    } finally {
      setIsDemoSubmitting(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);

    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();

    if (!cleanEmail || !cleanPassword) {
      setErrorMessage('Please enter both email and password.');
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === 'login') {
        if (selectedRole === 'hospital') {
          await loginHospitalUser(cleanEmail, cleanPassword);
        } else if (selectedRole === 'driver') {
          await loginDriverUser(cleanEmail, cleanPassword);
        } else {
          const session = await loginAdmin({ email: cleanEmail, password: cleanPassword });
          persistAdminSession({
            token: session.token,
            user: {
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
              role: session.user.role,
            },
          });
        }
      } else {
        const cleanName = nameOrId.trim() || activeRoleConfig.label;
        if (selectedRole === 'hospital') {
          await signupHospitalUser(
            cleanName.toUpperCase(),
            cleanEmail,
            cleanPassword,
            { lat: 19.076, lng: 72.8777 },
            100,
          );
        } else if (selectedRole === 'driver') {
          await signupDriverUser(
            cleanName,
            cleanEmail,
            cleanPassword,
            '9876543210',
            'MH-01-0000',
            'HSP-MUM-001',
          );
        } else {
          const session = await signupAdmin({
            adminName: cleanName,
            email: cleanEmail,
            password: cleanPassword,
          });
          persistAdminSession({
            token: session.token,
            user: {
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
              role: session.user.role,
            },
          });
        }
      }

      setExclusiveSessionForRole(selectedRole);
      redirectToPath(dashboardPathByRole(selectedRole));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Authentication failed. Please check your credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-page-card" aria-label="Authentication portal">
        <div className="auth-page-header">
          <p className="auth-page-eyebrow">
            {isAdminSecretRoute ? <Shield size={14} className="auth-icon-inline" /> : null}
            {isAdminSecretRoute ? 'Secure Admin Access' : 'Unified Portal Access'}
          </p>
          <h1>
            {mode === 'login'
              ? `Login to ${activeRoleConfig.label} Portal`
              : `Create ${activeRoleConfig.label} Account`}
          </h1>
          <p className="auth-page-subtitle">{activeRoleConfig.subtitle}</p>
        </div>

        {/* Role Switcher */}
        {allowedRoles.length > 1 ? (
          <div className="auth-page-role-switch" role="tablist" aria-label="Select role">
            {allowedRoles.map((role) => (
              <button
                key={role}
                type="button"
                className={selectedRole === role ? 'active' : ''}
                onClick={() => setSelectedRole(role)}
              >
                {ROLE_CONFIG[role].label}
              </button>
            ))}
          </div>
        ) : null}

        {/* 1-Click Instant Demo Login Button */}
        <div className="auth-page-demo-section">
          <button
            type="button"
            className="auth-page-demo-btn"
            onClick={handleDemoLogin}
            disabled={isDemoSubmitting || isSubmitting}
          >
            <Sparkles size={18} className="auth-demo-icon" />
            <span>
              {isDemoSubmitting
                ? `Logging in as Demo ${activeRoleConfig.label}...`
                : `1-Click Demo Login as ${activeRoleConfig.label}`}
            </span>
            <ArrowRight size={16} />
          </button>
        </div>

        {/* Divider */}
        <div className="auth-page-divider">
          <span>or continue with credentials</span>
        </div>

        {/* Mode Switcher (Login / Signup) */}
        {!isAdminSecretRoute ? (
          <div className="auth-page-mode-switch" role="tablist" aria-label="Select mode">
            <button
              type="button"
              className={mode === 'login' ? 'active' : ''}
              onClick={() => setMode('login')}
            >
              Login
            </button>
            <button
              type="button"
              className={mode === 'signup' ? 'active' : ''}
              onClick={() => setMode('signup')}
            >
              Signup
            </button>
          </div>
        ) : null}

        {/* Form */}
        <form className="auth-page-form" onSubmit={handleSubmit}>
          {mode === 'signup' ? (
            <label>
              {selectedRole === 'hospital' ? 'Hospital Name / Code' : 'Full Name'}
              <input
                type="text"
                value={nameOrId}
                onChange={(e) => setNameOrId(e.target.value)}
                placeholder={selectedRole === 'hospital' ? 'e.g. Apollo ER' : 'e.g. Rajesh Kumar'}
                required
              />
            </label>
          ) : null}

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={activeRoleConfig.emailPlaceholder}
              autoComplete="email"
              required
            />
          </label>

          <label className="auth-page-password-wrap">
            Password
            <div className="auth-page-password-control">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                tabIndex={-1}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          {errorMessage ? (
            <p className="auth-page-toast" role="status">
              <AlertCircle size={16} className="auth-icon-inline" /> {errorMessage}
            </p>
          ) : null}

          <button
            type="submit"
            className="auth-page-submit"
            disabled={isSubmitting || isDemoSubmitting}
          >
            {isSubmitting
              ? 'Please wait...'
              : mode === 'login'
                ? `Login As ${activeRoleConfig.label}`
                : `Create ${activeRoleConfig.label} Account`}
          </button>
        </form>

        <a href="#/" className="auth-page-back-link">
          ← Back to Home
        </a>
      </section>
    </main>
  );
}
