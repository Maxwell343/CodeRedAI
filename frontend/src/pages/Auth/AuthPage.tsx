import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Map, { Marker, NavigationControl } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';

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
  signupNameLabel: string;
  signupNamePlaceholder: string;
  emailPlaceholder: string;
}

const ROLE_CONFIG: Record<AppRole, RoleConfig> = {
  hospital: {
    label: 'Hospital',
    subtitle: 'Manage emergency intake and dispatch from your hospital command dashboard.',
    signupNameLabel: 'Hospital Name',
    signupNamePlaceholder: 'Enter hospital name',
    emailPlaceholder: 'apollo.er@codered.ai',
  },
  driver: {
    label: 'Driver',
    subtitle: 'Access live missions, route guidance, and earnings insights in one place.',
    signupNameLabel: 'Driver Name',
    signupNamePlaceholder: 'Enter driver name',
    emailPlaceholder: 'driver.rajesh@codered.ai',
  },
  admin: {
    label: 'Admin',
    subtitle: 'Secure operations oversight with verification, quality, and compliance controls.',
    signupNameLabel: 'Admin Name',
    signupNamePlaceholder: 'Enter admin name',
    emailPlaceholder: 'admin.ops@codered.ai',
  },
};

const ADMIN_DEFAULT_PASSWORD = 'Admin@123';
const ADMIN_SIGNUP_ACCESS_CODE = (import.meta.env.VITE_ADMIN_ACCESS_CODE as string | undefined)?.trim() || 'CODERED-ADMIN-ACCESS';
const ADMIN_QUICK_FILL_EMAILS = [
  'admin.ops@codered.ai',
  'admin.verify@codered.ai',
  'admin.reviews@codered.ai',
  'admin.compliance@codered.ai',
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRONG_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
const PHONE_PATTERN = /^[0-9+()\-\s]{7,20}$/;
const VEHICLE_NUMBER_PATTERN = /^[A-Za-z0-9\-\s]{4,20}$/;
const HOSPITAL_ID_PATTERN = /^[A-Za-z0-9\-]{4,30}$/;
const PUBLIC_AUTH_ROLES: AppRole[] = ['hospital', 'driver'];
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || '';
const DEFAULT_HOSPITAL_SIGNUP_LOCATION = {
  lat: 19.1177786,
  lng: 72.8780686,
};

function getCurrentHashPath(): string {
  if (typeof window === 'undefined') {
    return '/';
  }

  return normalizeAppPath(window.location.hash.replace(/^#/, '') || '/');
}

function initialEmailByRole(role: AppRole, hospitalEmails: string[], driverEmails: string[]) {
  if (role === 'hospital') {
    return hospitalEmails[0] || 'apollo.er@codered.ai';
  }

  if (role === 'driver') {
    return driverEmails[0] || 'driver.rajesh@codered.ai';
  }

  return ADMIN_QUICK_FILL_EMAILS[0];
}

function initialPasswordByRole(role: AppRole, hospitalPassword: string, driverPassword: string) {
  if (role === 'hospital') {
    return hospitalPassword || 'Password@123';
  }

  if (role === 'driver') {
    return driverPassword || 'Password@123';
  }

  return ADMIN_DEFAULT_PASSWORD;
}

function formHeading(role: AppRole, mode: AuthMode) {
  if (mode === 'login') {
    if (role === 'hospital') {
      return 'Login To Hospital Dashboard';
    }

    if (role === 'driver') {
      return 'Login To Driver Dashboard';
    }

    return 'Login To Admin Dashboard';
  }

  if (role === 'hospital') {
    return 'Create Hospital Account';
  }

  if (role === 'driver') {
    return 'Create Driver Account';
  }

  return 'Create Admin Account';
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
  const [accountName, setAccountName] = useState('');
  const [hospitalSignupId, setHospitalSignupId] = useState('');
  const [hospitalBedCapacity, setHospitalBedCapacity] = useState('');
  const [hospitalSignupLocation, setHospitalSignupLocation] = useState(DEFAULT_HOSPITAL_SIGNUP_LOCATION);
  const [hospitalLocationPicked, setHospitalLocationPicked] = useState(false);
  const [email, setEmail] = useState(() =>
    initialEmailByRole(isAdminSecretRoute ? 'admin' : 'hospital', presetHospitalEmails, presetDriverEmails),
  );
  const [password, setPassword] = useState(() =>
    initialPasswordByRole(isAdminSecretRoute ? 'admin' : 'hospital', defaultHospitalPassword, defaultDriverPassword),
  );
  const [confirmPassword, setConfirmPassword] = useState(() =>
    initialPasswordByRole(isAdminSecretRoute ? 'admin' : 'hospital', defaultHospitalPassword, defaultDriverPassword),
  );
  const [adminAccessCode, setAdminAccessCode] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [driverVehicleNumber, setDriverVehicleNumber] = useState('');
  const [driverLinkedHospitalId, setDriverLinkedHospitalId] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeRoleConfig = ROLE_CONFIG[selectedRole];

  const quickFillEmails = useMemo(() => {
    if (selectedRole === 'hospital') {
      return presetHospitalEmails.slice(0, 10);
    }

    if (selectedRole === 'driver') {
      return presetDriverEmails.slice(0, 8);
    }

    return ADMIN_QUICK_FILL_EMAILS;
  }, [selectedRole, presetHospitalEmails, presetDriverEmails]);

  const credentialHint = useMemo(() => {
    if (selectedRole === 'hospital') {
      return `Click any demo hospital below or use password ${defaultHospitalPassword || 'Password@123'}.`;
    }

    if (selectedRole === 'driver') {
      return `Click any demo driver below or use password ${defaultDriverPassword || 'Password@123'}.`;
    }

    return `Click any demo admin below or use password ${ADMIN_DEFAULT_PASSWORD}.`;
  }, [selectedRole, defaultHospitalPassword, defaultDriverPassword]);

  const setExclusiveSessionForRole = useCallback(
    (role: AppRole) => {
      if (role !== 'hospital') {
        logoutHospitalUser();
      }

      if (role !== 'driver') {
        logoutDriverUser();
      }

      if (role !== 'admin') {
        clearStoredAdminSession();
      }
    },
    [logoutDriverUser, logoutHospitalUser],
  );

  useEffect(() => {
    if (isAdminSecretRoute) {
      return;
    }

    const authenticatedRole = resolveAuthenticatedRole({
      isHospitalAuthenticated: Boolean(isHospitalAuthenticated && hospitalUser),
      isDriverAuthenticated: Boolean(isDriverAuthenticated && driverUser),
      hasAdminSession: Boolean(readStoredAdminSession()),
    });

    if (!authenticatedRole) {
      return;
    }

    redirectToPath(dashboardPathByRole(authenticatedRole));
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

  useEffect(() => {
    setErrorMessage(null);
    setAccountName('');
    setHospitalSignupId('');
    setHospitalBedCapacity('');
    setHospitalSignupLocation(DEFAULT_HOSPITAL_SIGNUP_LOCATION);
    setHospitalLocationPicked(false);
    setAdminAccessCode('');
    setDriverPhone('');
    setDriverVehicleNumber('');
    setDriverLinkedHospitalId('');

    const nextEmail = initialEmailByRole(selectedRole, presetHospitalEmails, presetDriverEmails);
    const nextPassword = initialPasswordByRole(selectedRole, defaultHospitalPassword, defaultDriverPassword);

    setEmail(nextEmail);
    setPassword(nextPassword);
    setConfirmPassword(nextPassword);
    setShowPassword(false);
    setShowConfirmPassword(false);
  }, [selectedRole]);

  const handleQuickFill = (candidateEmail: string) => {
    setEmail(candidateEmail);
    const nextPassword = initialPasswordByRole(selectedRole, defaultHospitalPassword, defaultDriverPassword);
    setPassword(nextPassword);
    setConfirmPassword(nextPassword);
    setErrorMessage(null);
  };

  const validateForm = () => {
    if (!email.trim() || !password.trim()) {
      return 'Email and password are required.';
    }

    if (!EMAIL_PATTERN.test(email.trim())) {
      return 'Enter a valid email address.';
    }

    if (selectedRole === 'admin' && !isAdminSecretRoute) {
      return 'Admin login is available only through secure access.';
    }

    if (mode === 'signup' && selectedRole === 'hospital' && !hospitalSignupId.trim()) {
      return 'Hospital ID is required for signup.';
    }

    if (mode === 'signup' && selectedRole === 'hospital' && !HOSPITAL_ID_PATTERN.test(hospitalSignupId.trim())) {
      return 'Enter a valid hospital ID.';
    }

    if (mode === 'signup' && selectedRole === 'hospital' && !hospitalBedCapacity.trim()) {
      return 'Bed capacity is required for signup.';
    }

    if (mode === 'signup' && selectedRole === 'hospital') {
      const parsedCapacity = Number.parseInt(hospitalBedCapacity.trim(), 10);
      if (!Number.isFinite(parsedCapacity) || parsedCapacity < 1 || parsedCapacity > 5000) {
        return 'Bed capacity must be between 1 and 5000.';
      }
    }

    if (mode === 'signup' && selectedRole === 'hospital' && MAPBOX_TOKEN && !hospitalLocationPicked) {
      return 'Select hospital location on the map.';
    }

    if (mode === 'signup' && selectedRole === 'driver' && !driverPhone.trim()) {
      return 'Phone is required for driver signup.';
    }

    if (mode === 'signup' && selectedRole === 'driver' && !PHONE_PATTERN.test(driverPhone.trim())) {
      return 'Enter a valid phone number.';
    }

    if (mode === 'signup' && selectedRole === 'driver' && !driverVehicleNumber.trim()) {
      return 'Vehicle number is required for driver signup.';
    }

    if (mode === 'signup' && selectedRole === 'driver' && !VEHICLE_NUMBER_PATTERN.test(driverVehicleNumber.trim())) {
      return 'Enter a valid vehicle number.';
    }

    if (mode === 'signup' && selectedRole === 'driver' && !driverLinkedHospitalId.trim()) {
      return 'Linked hospital ID is required for driver signup.';
    }

    if (
      mode === 'signup' &&
      selectedRole === 'driver' &&
      !HOSPITAL_ID_PATTERN.test(driverLinkedHospitalId.trim())
    ) {
      return 'Enter a valid linked hospital ID.';
    }

    if (mode === 'signup' && selectedRole !== 'hospital' && !accountName.trim()) {
      return `${activeRoleConfig.signupNameLabel} is required for signup.`;
    }

    if (mode === 'signup' && !STRONG_PASSWORD_PATTERN.test(password)) {
      return 'Password must be at least 8 characters with upper, lower, number, and special character.';
    }

    if (mode === 'signup' && password !== confirmPassword) {
      return 'Password and confirm password do not match.';
    }

    if (selectedRole === 'admin' && mode === 'signup' && adminAccessCode.trim() !== ADMIN_SIGNUP_ACCESS_CODE) {
      return 'Invalid admin access code.';
    }

    return null;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);

    const validationError = validateForm();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    const normalizedName = accountName.trim();
    const normalizedHospitalId = hospitalSignupId.trim().toUpperCase();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPassword = password.trim();
    const normalizedHospitalBedCapacity = Number.parseInt(hospitalBedCapacity.trim(), 10);
    const normalizedHospitalLocation = {
      lat: hospitalSignupLocation.lat,
      lng: hospitalSignupLocation.lng,
    };
    const normalizedPhone = driverPhone.trim();
    const normalizedVehicleNumber = driverVehicleNumber.trim().toUpperCase();
    const normalizedLinkedHospitalId = driverLinkedHospitalId.trim().toUpperCase();

    setIsSubmitting(true);

    try {
      if (mode === 'login') {
        if (selectedRole === 'hospital') {
          await loginHospitalUser(normalizedEmail, normalizedPassword);
        } else if (selectedRole === 'driver') {
          await loginDriverUser(normalizedEmail, normalizedPassword);
        } else {
          const session = await loginAdmin({ email: normalizedEmail, password: normalizedPassword });
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
      } else if (selectedRole === 'hospital') {
        await signupHospitalUser(
          normalizedHospitalId,
          normalizedEmail,
          normalizedPassword,
          normalizedHospitalLocation,
          normalizedHospitalBedCapacity,
        );
      } else if (selectedRole === 'driver') {
        await signupDriverUser(
          normalizedName,
          normalizedEmail,
          normalizedPassword,
          normalizedPhone,
          normalizedVehicleNumber,
          normalizedLinkedHospitalId,
        );
      } else {
        const session = await signupAdmin({
          adminName: normalizedName,
          email: normalizedEmail,
          password: normalizedPassword,
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

      setExclusiveSessionForRole(selectedRole);
      redirectToPath(dashboardPathByRole(selectedRole));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitLabel =
    mode === 'login'
      ? `Login As ${activeRoleConfig.label}`
      : `Create ${activeRoleConfig.label} Account`;

  return (
    <main className="auth-page">
      <section className="auth-page-card" aria-label="Unified authentication">
        <p className="auth-page-eyebrow">Unified Access</p>
        <h1>{formHeading(selectedRole, mode)}</h1>
        <p className="auth-page-subtitle">{activeRoleConfig.subtitle}</p>

        {allowedRoles.length > 1 ? (
          <div className="auth-page-role-switch" role="tablist" aria-label="Select account role">
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

        {!isAdminSecretRoute ? (
          <div className="auth-page-mode-switch" role="tablist" aria-label="Select authentication mode">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              Login
            </button>
            <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
              Signup
            </button>
          </div>
        ) : null}

        <p className="auth-page-hint">{credentialHint}</p>

        <form className="auth-page-form" onSubmit={handleSubmit}>
          {mode === 'signup' && selectedRole !== 'hospital' ? (
            <label>
              {activeRoleConfig.signupNameLabel}
              <input
                type="text"
                value={accountName}
                onChange={(event) => setAccountName(event.target.value)}
                placeholder={activeRoleConfig.signupNamePlaceholder}
                autoComplete="name"
                required
              />
            </label>
          ) : null}

          {mode === 'signup' && selectedRole === 'hospital' ? (
            <>
              <label>
                Hospital ID
                <input
                  type="text"
                  value={hospitalSignupId}
                  onChange={(event) => setHospitalSignupId(event.target.value.toUpperCase())}
                  placeholder="HSP-MUM-009"
                  autoComplete="off"
                  required
                />
              </label>

              <label>
                Bed Capacity
                <input
                  type="number"
                  value={hospitalBedCapacity}
                  onChange={(event) => setHospitalBedCapacity(event.target.value)}
                  placeholder="120"
                  min={1}
                  max={5000}
                  step={1}
                  required
                />
              </label>

              <div className="auth-page-map-field" aria-label="Hospital location picker">
                <p>Select Hospital Location</p>

                {MAPBOX_TOKEN ? (
                  <div className="auth-page-map-shell">
                    <Map
                      mapboxAccessToken={MAPBOX_TOKEN}
                      initialViewState={{
                        latitude: hospitalSignupLocation.lat,
                        longitude: hospitalSignupLocation.lng,
                        zoom: 12,
                      }}
                      mapStyle="mapbox://styles/mapbox/streets-v12"
                      style={{ width: '100%', height: '100%' }}
                      onClick={(event) => {
                        setHospitalSignupLocation({
                          lat: event.lngLat.lat,
                          lng: event.lngLat.lng,
                        });
                        setHospitalLocationPicked(true);
                      }}
                    >
                      <NavigationControl position="top-right" />
                      <Marker
                        longitude={hospitalSignupLocation.lng}
                        latitude={hospitalSignupLocation.lat}
                        color="#d72b2b"
                      />
                    </Map>
                  </div>
                ) : (
                  <p className="auth-page-map-warning">
                    Mapbox token missing. Set VITE_MAPBOX_ACCESS_TOKEN to pick exact hospital location on map.
                  </p>
                )}

                <p className="auth-page-map-coords">
                  Selected: {hospitalSignupLocation.lat.toFixed(6)}, {hospitalSignupLocation.lng.toFixed(6)}
                </p>
              </div>
            </>
          ) : null}

          {mode === 'signup' && selectedRole === 'driver' ? (
            <>
              <label>
                Phone
                <input
                  type="tel"
                  value={driverPhone}
                  onChange={(event) => setDriverPhone(event.target.value)}
                  placeholder="9876543210"
                  autoComplete="tel"
                  required
                />
              </label>

              <label>
                Vehicle Number
                <input
                  type="text"
                  value={driverVehicleNumber}
                  onChange={(event) => setDriverVehicleNumber(event.target.value.toUpperCase())}
                  placeholder="MH-01-0000"
                  autoComplete="off"
                  required
                />
              </label>

              <label>
                Linked Hospital ID
                <input
                  type="text"
                  value={driverLinkedHospitalId}
                  onChange={(event) => setDriverLinkedHospitalId(event.target.value.toUpperCase())}
                  placeholder="HSP-MUM-009"
                  autoComplete="off"
                  required
                />
              </label>
            </>
          ) : null}

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
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
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password@123"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
              <button type="button" onClick={() => setShowPassword((current) => !current)}>
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          {mode === 'signup' ? (
            <label className="auth-page-password-wrap">
              Confirm Password
              <div className="auth-page-password-control">
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Password@123"
                  autoComplete="new-password"
                  required
                />
                <button type="button" onClick={() => setShowConfirmPassword((current) => !current)}>
                  {showConfirmPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
          ) : null}

          {selectedRole === 'admin' && mode === 'signup' ? (
            <label>
              Admin Access Code
              <input
                type="text"
                value={adminAccessCode}
                onChange={(event) => setAdminAccessCode(event.target.value)}
                placeholder="Enter authorized admin code"
                autoComplete="off"
                required
              />
            </label>
          ) : null}

          {errorMessage ? (
            <p className="auth-page-toast" role="status">
              {errorMessage}
            </p>
          ) : null}

          <button type="submit" className="auth-page-submit" disabled={isSubmitting}>
            {isSubmitting ? 'Please wait...' : submitLabel}
          </button>
        </form>

        {quickFillEmails.length > 0 ? (
          <div className="auth-page-presets">
            <p>Quick Fill Accounts</p>
            <div className="auth-page-chip-grid">
              {quickFillEmails.map((presetEmail) => (
                <button
                  key={presetEmail}
                  type="button"
                  className="auth-page-chip"
                  onClick={() => handleQuickFill(presetEmail)}
                >
                  {presetEmail}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {selectedRole === 'admin' && mode === 'signup' ? (
          <p className="auth-page-note">Admin signup requires an approved internal access code.</p>
        ) : null}

        <a href="#/" className="auth-page-back-link">
          Back to Home
        </a>
      </section>
    </main>
  );
}
