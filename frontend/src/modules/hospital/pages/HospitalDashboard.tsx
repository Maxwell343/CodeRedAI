import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Menu,
  Radio,
  ShieldCheck,
  Truck,
  X,
  type LucideIcon,
} from 'lucide-react';


import { AlertBanner } from '@shared/components/AlertBanner';
import { MapView } from '@shared/components/MapView';
import { StatusBadge } from '@shared/components/StatusBadge';
import { useHospitalAuth } from '@shared/providers/AuthContext';
import { getPresetDriverAccounts, type PresetDriverAccount } from '@shared/utils/driverAuthApi';
import {
  DriverStatus,
  DriverUnit,
  HospitalBedState,
  HospitalLocationRef,
  HospitalOpsState,
  OpsEvent,
  OpsEventType,
  RequestStatus,
  SeverityLevel,
} from '@shared/types/hospitalOps.types';
import { createInitialHospitalOpsState, isDemoHospitalAccount } from '@shared/utils/hospitalDemoData';
import {
  addIncomingPatientRequest,
  buildRoadRoute,
  fetchStrictRoadRouteFromApi,
  routeDistanceKm,
  runDriverPingCycle,
} from '@shared/utils/hospitalOpsSimulator';
import { formatDate } from '@shared/utils/formatters';
import './HospitalDashboard.css';

const STORAGE_KEY_PREFIX = 'codered-hospital-demo-v3';
const DRIVER_PING_SECONDS = 5;
const AUTO_INTAKE_SECONDS = 42;
const ROSTER_SYNC_SECONDS = 12;
const MOBILE_NAV_QUERY = '(max-width: 980px)';

type HospitalSectionKey = 'dashboard' | 'queue' | 'ambulance' | 'beds';

const hospitalSections: Array<{ key: HospitalSectionKey; label: string; description: string; icon: LucideIcon }> = [
  { key: 'dashboard',  label: 'Dashboard',            description: 'Analytics and live hospital overview',           icon: LayoutDashboard },
  { key: 'queue',      label: 'Patient Queue',         description: 'Queue, live map, and dispatch control',          icon: Radio },
  { key: 'ambulance',  label: 'Ambulance Dashboard',   description: 'Ambulance and driver operational status',        icon: Truck },
  { key: 'beds',       label: 'Bed Manager',           description: 'Bed and ICU capacity controls',                  icon: ShieldCheck },
];

function isMobileViewport() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(MOBILE_NAV_QUERY).matches;
}


const severityPriority: Record<SeverityLevel, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
};

const severityTone: Record<SeverityLevel, 'danger' | 'warning' | 'info' | 'neutral'> = {
  critical: 'danger',
  high: 'warning',
  moderate: 'info',
  low: 'neutral',
};

const requestStatusTone: Record<RequestStatus, 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  new: 'danger',
  triaged: 'warning',
  dispatched: 'info',
  completed: 'success',
  cancelled: 'neutral',
};

const requestStatusLabel: Record<RequestStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  dispatched: 'Dispatched',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const driverStatusTone: Record<DriverStatus, 'success' | 'danger' | 'info' | 'warning' | 'neutral'> = {
  available: 'success',
  to_patient: 'danger',
  with_patient: 'warning',
  to_hospital: 'info',
  offline: 'neutral',
};

const driverStatusLabel: Record<DriverStatus, string> = {
  available: 'Available',
  to_patient: 'En Route',
  with_patient: 'On Scene',
  to_hospital: 'To Hospital',
  offline: 'Offline',
};

const requestFilters: Array<{ key: 'all' | RequestStatus; label: string }> = [
  { key: 'all', label: 'All Open' },
  { key: 'new', label: 'New' },
  { key: 'triaged', label: 'Triaged' },
  { key: 'dispatched', label: 'Dispatched' },
];

const DEFAULT_HOSPITAL_REF: HospitalLocationRef = {
  id: 'HSP-MUM-009',
  name: 'Seven Hills Hospital',
  address: 'Marol Maroshi Road, Andheri East, Mumbai 400059',
  location: { lat: 19.1177786, lng: 72.8780686 },
};

interface ClosestDriverSuggestion {
  requestId: string;
  driverId: string;
  driverCallSign: string;
  driverName: string;
  distanceKm: number;
  etaMinutes: number;
}

function sanitizeCallSign(value: string | undefined) {
  return value?.trim() || undefined;
}

function fallbackCallSign(account: PresetDriverAccount, seedIndex: number) {
  const source = (account.name || account.email).toUpperCase().replace(/[^A-Z]/g, '');
  const prefix = source.slice(0, 3) || 'DRV';
  return `${prefix}-${String((seedIndex % 900) + 100)}`;
}

function createRosterDriverUnit(
  account: PresetDriverAccount,
  hospitalId: string,
  hospitalLocation: { lat: number; lng: number },
  seedIndex: number,
): DriverUnit {
  const angle = ((seedIndex * 57) % 360) * (Math.PI / 180);
  const radius = 0.004 + ((seedIndex % 8) + 1) * 0.00045;
  const latOffset = Math.sin(angle) * radius;
  const lngOffset = Math.cos(angle) * radius;

  return {
    id: account.id,
    callSign: sanitizeCallSign(account.callSign) ?? fallbackCallSign(account, seedIndex),
    name: account.name || account.email,
    vehicleNumber: `MH-01-EM-${String((seedIndex % 9000) + 1000).padStart(4, '0')}`,
    phone: `+91 90000 ${String((seedIndex % 100000)).padStart(5, '0')}`,
    linkedHospitalId: hospitalId,
    status: 'available',
    occupied: false,
    location: {
      lat: hospitalLocation.lat + latOffset,
      lng: hospitalLocation.lng + lngOffset,
    },
    speedKmph: 38 + (seedIndex % 14),
    fuelPct: 58 + (seedIndex % 40),
    lastPingAt: new Date().toISOString(),
    pingIntervalSec: 6,
    secondsSincePing: 0,
  };
}

function mergeRosterWithPresetDrivers(params: {
  stateDrivers: DriverUnit[];
  presetDrivers: PresetDriverAccount[];
  hospitalId: string;
  hospitalLocation: { lat: number; lng: number };
}): DriverUnit[] {
  const { stateDrivers, presetDrivers, hospitalId, hospitalLocation } = params;

  if (presetDrivers.length === 0) {
    return stateDrivers;
  }

  const nextDrivers = [...stateDrivers];
  const indexByDriverId = new Map(nextDrivers.map((driver, index) => [driver.id, index]));
  let hasChanges = false;

  presetDrivers.forEach((account, index) => {
    const driverId = account.id?.trim();
    if (!driverId) {
      return;
    }

    const existingIndex = indexByDriverId.get(driverId);

    if (existingIndex === undefined) {
      nextDrivers.push(createRosterDriverUnit(account, hospitalId, hospitalLocation, nextDrivers.length + index));
      hasChanges = true;
      return;
    }

    const existing = nextDrivers[existingIndex];
    const updated: DriverUnit = {
      ...existing,
      linkedHospitalId: hospitalId,
      callSign: existing.callSign || sanitizeCallSign(account.callSign) || fallbackCallSign(account, existingIndex),
      name: existing.name || account.name || account.email,
    };

    if (
      updated.linkedHospitalId !== existing.linkedHospitalId ||
      updated.callSign !== existing.callSign ||
      updated.name !== existing.name
    ) {
      nextDrivers[existingIndex] = updated;
      hasChanges = true;
    }
  });

  return hasChanges ? nextDrivers : stateDrivers;
}

function isHospitalOpsState(candidate: unknown): candidate is HospitalOpsState {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Partial<HospitalOpsState>;
  return Boolean(
    value.hospital &&
      Array.isArray(value.drivers) &&
      Array.isArray(value.requests) &&
      Array.isArray(value.events) &&
      typeof value.nextRequestNumber === 'number',
  );
}

function stateStorageKey(hospitalId: string) {
  return `${STORAGE_KEY_PREFIX}-${hospitalId}`;
}

function loadInitialState(hospitalRef: HospitalLocationRef, email?: string) {
  const isDemo = isDemoHospitalAccount(hospitalRef.id, email);
  if (typeof window === 'undefined') return createInitialHospitalOpsState(hospitalRef, isDemo);
  const persisted = window.localStorage.getItem(stateStorageKey(hospitalRef.id));
  if (!persisted) return createInitialHospitalOpsState(hospitalRef, isDemo);
  try {
    const parsed = JSON.parse(persisted) as unknown;
    if (isHospitalOpsState(parsed)) return parsed;
  } catch {
    return createInitialHospitalOpsState(hospitalRef, isDemo);
  }
  return createInitialHospitalOpsState(hospitalRef, isDemo);
}

function createEvent(type: OpsEventType, message: string, requestId?: string, driverId?: string): OpsEvent {
  return {
    id: `EVT-${Date.now()}-${Math.floor(Math.random() * 100_000)}`,
    at: new Date().toISOString(),
    type,
    message,
    requestId,
    driverId,
  };
}

function appendEvent(
  state: HospitalOpsState,
  type: OpsEventType,
  message: string,
  requestId?: string,
  driverId?: string,
) {
  const event = createEvent(type, message, requestId, driverId);
  return { ...state, events: [event, ...state.events].slice(0, 60) };
}

function normalizeBedState(beds: HospitalBedState): HospitalBedState {
  const totalBeds = Math.max(0, Math.round(beds.totalBeds));
  const occupiedBeds = Math.min(totalBeds, Math.max(0, Math.round(beds.occupiedBeds)));
  const icuTotal = Math.min(totalBeds, Math.max(0, Math.round(beds.icuTotal)));
  const icuOccupied = Math.min(occupiedBeds, icuTotal, Math.max(0, Math.round(beds.icuOccupied)));
  return { totalBeds, occupiedBeds, icuTotal, icuOccupied };
}

function adjustBeds(beds: HospitalBedState, field: keyof HospitalBedState, delta: number) {
  const draft = { ...beds, [field]: beds[field] + delta };
  const nextBeds = normalizeBedState(draft);
  const changed =
    nextBeds.totalBeds !== beds.totalBeds ||
    nextBeds.occupiedBeds !== beds.occupiedBeds ||
    nextBeds.icuTotal !== beds.icuTotal ||
    nextBeds.icuOccupied !== beds.icuOccupied;
  return { nextBeds, changed };
}

function dispatchRequestToDriver(
  state: HospitalOpsState,
  requestId: string,
  driverId: string,
  routeToPatient: { lat: number; lng: number }[],
  routeToHospital: { lat: number; lng: number }[],
) {
  const request = state.requests.find((item) => item.id === requestId);
  const driver = state.drivers.find((item) => item.id === driverId);
  if (!request || !driver) return state;
  if (!(request.status === 'new' || request.status === 'triaged')) return state;
  if (driver.status !== 'available' || driver.occupied) return state;
  if (routeToPatient.length < 2 || routeToHospital.length < 2) return state;

  const routeStartPoint = routeToPatient[0] ?? driver.location;
  const routeDistance = routeDistanceKm(routeToPatient);
  const etaMinutes = Math.max(1, Math.round((routeDistance / Math.max(driver.speedKmph, 24)) * 60));
  const nowIso = new Date().toISOString();

  const requests = state.requests.map((item) =>
    item.id !== requestId
      ? item
      : {
          ...item,
          status: 'dispatched' as const,
          assignedDriverId: driverId,
          hospitalId: state.hospital.id,
          notes: `${item.notes ? `${item.notes} | ` : ''}Dispatched to ${driver.callSign}.`,
        },
  );

  const drivers = state.drivers.map((item) =>
    item.id !== driverId
      ? item
      : {
          ...item,
          location: { lat: routeStartPoint.lat, lng: routeStartPoint.lng },
          status: 'to_patient' as const,
          occupied: false,
          assignment: {
            requestId,
            stage: 'to_patient' as const,
            stageTicks: 0,
            route: routeToPatient,
            routeIndex: 1,
            hospitalRoute: routeToHospital,
          },
          etaMinutes,
          lastPingAt: nowIso,
          secondsSincePing: 0,
        },
  );

  return appendEvent(
    { ...state, requests, drivers },
    'dispatch',
    `${driver.callSign} dispatched to ${request.id} (${request.severity.toUpperCase()}).`,
    request.id,
    driver.id,
  );
}

function formatPingAge(lastPingAt: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(lastPingAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

function eventTone(eventType: OpsEventType): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (eventType === 'incoming') return 'danger';
  if (eventType === 'triage' || eventType === 'capacity') return 'warning';
  if (eventType === 'handover') return 'success';
  if (eventType === 'dispatch' || eventType === 'arrival') return 'info';
  return 'neutral';
}

export function HospitalDashboard() {
  const {
    driverUser,
    hospitalUser,
    isHospitalAuthenticated,
    logoutHospitalUser,
  } = useHospitalAuth();

  const activeHospitalRef = useMemo<HospitalLocationRef>(
    () =>
      hospitalUser
        ? {
            id: hospitalUser.id,
            name: hospitalUser.name,
            address: hospitalUser.address ?? DEFAULT_HOSPITAL_REF.address,
            location: hospitalUser.location
              ? { ...hospitalUser.location }
              : { ...DEFAULT_HOSPITAL_REF.location },
          }
        : DEFAULT_HOSPITAL_REF,
    [hospitalUser],
  );

  const [opsState, setOpsState] = useState<HospitalOpsState>(() => loadInitialState(activeHospitalRef, hospitalUser?.email));
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [requestFilter, setRequestFilter] = useState<'all' | RequestStatus>('all');
  const [activeSection, setActiveSection] = useState<HospitalSectionKey>('dashboard');
  const [isDesktopNavOpen, setIsDesktopNavOpen] = useState(true);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState<string | null>(null);
  const [closestSuggestion, setClosestSuggestion] = useState<ClosestDriverSuggestion | null>(null);
  const [isResolvingRoute, setIsResolvingRoute] = useState(false);
  const requestFilterRef = useRef<HTMLDivElement | null>(null);
  const [filterIndicatorStyle, setFilterIndicatorStyle] = useState({ left: 0, width: 0, visible: false });

  const syncFilterIndicator = useCallback(() => {
    const container = requestFilterRef.current;
    if (!container) {
      return;
    }

    const activeChip = container.querySelector<HTMLButtonElement>('.filter-chip.active');
    if (!activeChip) {
      setFilterIndicatorStyle((current) => ({ ...current, visible: false }));
      return;
    }

    setFilterIndicatorStyle({
      left: activeChip.offsetLeft,
      width: activeChip.offsetWidth,
      visible: true,
    });
  }, []);

  useEffect(() => {
    if (!hospitalUser) {
      return;
    }

    setOpsState(loadInitialState(activeHospitalRef, hospitalUser.email));
    setSelectedRequestId(null);
    setSelectedDriverId(null);
    setRequestFilter('all');
    setActiveSection('dashboard');
    setClosestSuggestion(null);
    setDispatchNotice(null);
  }, [activeHospitalRef, hospitalUser]);

  useEffect(() => {
    if (!hospitalUser) {
      return;
    }

    const id = window.setInterval(() => {
      setOpsState((prev) => runDriverPingCycle(prev, DRIVER_PING_SECONDS));
    }, DRIVER_PING_SECONDS * 1000);

    return () => window.clearInterval(id);
  }, [hospitalUser]);

  useEffect(() => {
    if (!hospitalUser) {
      return;
    }

    let isDisposed = false;

    const syncDriverRoster = async () => {
      try {
        const presetData = await getPresetDriverAccounts();

        if (isDisposed || presetData.drivers.length === 0) {
          return;
        }

        setOpsState((previousState) => {
          const mergedDrivers = mergeRosterWithPresetDrivers({
            stateDrivers: previousState.drivers,
            presetDrivers: presetData.drivers,
            hospitalId: previousState.hospital.id,
            hospitalLocation: previousState.hospital.location,
          });

          if (mergedDrivers === previousState.drivers) {
            return previousState;
          }

          return {
            ...previousState,
            drivers: mergedDrivers,
          };
        });
      } catch {
        // Keep existing roster when backend presets are temporarily unavailable.
      }
    };

    void syncDriverRoster();

    const intervalId = window.setInterval(() => {
      void syncDriverRoster();
    }, ROSTER_SYNC_SECONDS * 1000);

    return () => {
      isDisposed = true;
      window.clearInterval(intervalId);
    };
  }, [hospitalUser]);

  useEffect(() => {
    if (!hospitalUser) {
      return;
    }

    const id = window.setInterval(() => {
      setOpsState((prev) => {
        const active = prev.requests.filter(
          (r) => r.status !== 'completed' && r.status !== 'cancelled',
        ).length;
        if (active >= 10) return prev;
        if (Math.random() < 0.58) return addIncomingPatientRequest(prev);
        return prev;
      });
    }, AUTO_INTAKE_SECONDS * 1000);

    return () => window.clearInterval(id);
  }, [hospitalUser]);

  useEffect(() => {
    if (!hospitalUser) {
      return;
    }

    window.localStorage.setItem(stateStorageKey(activeHospitalRef.id), JSON.stringify(opsState));
  }, [opsState, activeHospitalRef.id, hospitalUser]);

  useEffect(() => {
    if (!selectedRequestId) return;
    if (!opsState.requests.some((r) => r.id === selectedRequestId)) setSelectedRequestId(null);
  }, [opsState.requests, selectedRequestId]);

  useEffect(() => {
    if (!selectedDriverId) return;
    if (!opsState.drivers.some((d) => d.id === selectedDriverId)) setSelectedDriverId(null);
  }, [opsState.drivers, selectedDriverId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncFilterIndicator);
    const onResize = () => syncFilterIndicator();

    window.addEventListener('resize', onResize);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', onResize);
    };
  }, [syncFilterIndicator]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncFilterIndicator);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [requestFilter, syncFilterIndicator]);

  useEffect(() => {
    if (!closestSuggestion) return;
    if (selectedRequestId !== closestSuggestion.requestId) setClosestSuggestion(null);
  }, [closestSuggestion, selectedRequestId]);

  useEffect(() => {
    if (!dispatchNotice) return;
    const id = window.setTimeout(() => setDispatchNotice(null), 4200);
    return () => window.clearTimeout(id);
  }, [dispatchNotice]);

  const linkedDrivers = useMemo(
    () => opsState.drivers.filter((d) => d.linkedHospitalId === opsState.hospital.id),
    [opsState.drivers, opsState.hospital.id],
  );

  const openRequests = useMemo(
    () => opsState.requests.filter((r) => r.status !== 'completed' && r.status !== 'cancelled'),
    [opsState.requests],
  );

  const dispatchableRequests = useMemo(
    () => openRequests.filter((r) => r.status === 'new' || r.status === 'triaged'),
    [openRequests],
  );

  const filteredRequests = useMemo(() => {
    const base = requestFilter === 'all' ? openRequests : openRequests.filter((r) => r.status === requestFilter);
    return [...base].sort((a, b) => {
      const sd = severityPriority[b.severity] - severityPriority[a.severity];
      if (sd !== 0) return sd;
      return new Date(b.reportedAt).getTime() - new Date(a.reportedAt).getTime();
    });
  }, [openRequests, requestFilter]);

  const availableDrivers = useMemo(
    () => linkedDrivers.filter((d) => d.status === 'available' && !d.occupied),
    [linkedDrivers],
  );

  const loggedInAvailableDriver = useMemo(
    () => (driverUser ? availableDrivers.find((driver) => driver.id === driverUser.id) ?? null : null),
    [availableDrivers, driverUser],
  );

  const activeTrips = useMemo(
    () => linkedDrivers.filter((d) => ['to_patient', 'with_patient', 'to_hospital'].includes(d.status)).length,
    [linkedDrivers],
  );

  const avgEtaMinutes = useMemo(() => {
    const pool = linkedDrivers
      .filter((d) => typeof d.etaMinutes === 'number' && d.status !== 'available' && d.status !== 'offline')
      .map((d) => d.etaMinutes ?? 0);
    if (pool.length === 0) return 0;
    return Math.round(pool.reduce((a, v) => a + v, 0) / pool.length);
  }, [linkedDrivers]);

  const selectedRequest = useMemo(
    () => (selectedRequestId ? opsState.requests.find((r) => r.id === selectedRequestId) ?? null : null),
    [opsState.requests, selectedRequestId],
  );

  const selectedDriver = useMemo(
    () => (selectedDriverId ? linkedDrivers.find((d) => d.id === selectedDriverId) ?? null : null),
    [linkedDrivers, selectedDriverId],
  );

  const availableBeds = opsState.hospital.beds.totalBeds - opsState.hospital.beds.occupiedBeds;
  const availableIcuBeds = opsState.hospital.beds.icuTotal - opsState.hospital.beds.icuOccupied;
  const bedPressure =
    opsState.hospital.beds.totalBeds === 0
      ? 0
      : opsState.hospital.beds.occupiedBeds / opsState.hospital.beds.totalBeds;
  const criticalCases = openRequests.filter((r) => r.severity === 'critical').length;
  const completedCases = opsState.requests.filter((r) => r.status === 'completed').length;
  const completionRate = opsState.requests.length === 0 ? 0 : Math.round((completedCases / opsState.requests.length) * 100);
  const lowFuelDrivers = linkedDrivers.filter((d) => d.fuelPct <= 25).length;
  const offlineDrivers = linkedDrivers.filter((d) => d.status === 'offline').length;
  const averageFuelPct = linkedDrivers.length === 0 ? 0 : Math.round(linkedDrivers.reduce((t, d) => t + d.fuelPct, 0) / linkedDrivers.length);
  const availableFleetPct = linkedDrivers.length === 0 ? 0 : Math.round((availableDrivers.length / linkedDrivers.length) * 100);
  const bedOccupancyPct = opsState.hospital.beds.totalBeds === 0 ? 0 : Math.round((opsState.hospital.beds.occupiedBeds / opsState.hospital.beds.totalBeds) * 100);
  const responseVelocityScore = avgEtaMinutes > 0 ? Math.max(0, 100 - avgEtaMinutes * 3) : 100;
  const dispatchReadinessScore = Math.max(0, Math.min(100, Math.round(availableFleetPct * 0.42 + (100 - bedOccupancyPct) * 0.26 + completionRate * 0.2 + responseVelocityScore * 0.12)));
  const scoreRingCircumference = 2 * Math.PI * 52;
  const miniRingCircumference = 2 * Math.PI * 30;
  const recentPriorityRequests = useMemo(() => [...openRequests].sort((a, b) => { const sd = (severityPriority[b.severity] ?? 0) - (severityPriority[a.severity] ?? 0); return sd !== 0 ? sd : new Date(b.reportedAt).getTime() - new Date(a.reportedAt).getTime(); }).slice(0, 5), [openRequests]);
  const capacityEvents = useMemo(() => opsState.events.filter((e) => e.type === 'capacity'), [opsState.events]);
  const activeSectionMeta = useMemo(() => hospitalSections.find((s) => s.key === activeSection) ?? hospitalSections[0]!, [activeSection]);

  const handleSimulateIncoming = () => {
    setOpsState((prev) => addIncomingPatientRequest(prev));
    setDispatchNotice('Simulated one incoming patient request.');
  };

  const handleResetDemo = () => {
    const isDemo = isDemoHospitalAccount(activeHospitalRef.id, hospitalUser?.email);
    setOpsState(createInitialHospitalOpsState(activeHospitalRef, isDemo));
    setSelectedDriverId(null);
    setSelectedRequestId(null);
    setRequestFilter('all');
    setClosestSuggestion(null);
    setDispatchNotice('Demo data has been reset to baseline.');
  };

  const handleTriageRequest = (requestId: string) => {
    setOpsState((prev) => {
      const request = prev.requests.find((r) => r.id === requestId);
      if (!request || request.status !== 'new') return prev;
      const requests = prev.requests.map((r) =>
        r.id !== requestId
          ? r
          : {
              ...r,
              status: 'triaged' as const,
              hospitalId: prev.hospital.id,
              notes: `${r.notes ? `${r.notes} | ` : ''}Triaged by hospital desk.`,
            },
      );
      return appendEvent({ ...prev, requests }, 'triage', `${request.id} triaged as ${request.severity.toUpperCase()}.`, request.id);
    });
    setSelectedRequestId(requestId);
    setDispatchNotice(`Request ${requestId} moved to triaged queue.`);
  };

  const dispatchWithDriver = async (requestId: string, driverId: string, mode: 'manual' | 'auto') => {
    const request = opsState.requests.find((r) => r.id === requestId);
    const driver = linkedDrivers.find((d) => d.id === driverId);
    if (!request || !driver) { setDispatchNotice('Unable to dispatch. Reselect request/driver.'); return; }
    if (!(request.status === 'new' || request.status === 'triaged')) { setDispatchNotice('Only new or triaged requests can be dispatched.'); return; }
    if (driver.status !== 'available' || driver.occupied) { setDispatchNotice('Selected driver is not available.'); return; }

    setIsResolvingRoute(true);

    try {
      const [routeToPatient, routeToHospital] = await Promise.all([
        fetchStrictRoadRouteFromApi(driver.location, request.location),
        fetchStrictRoadRouteFromApi(request.location, opsState.hospital.location),
      ]);

      if (!routeToPatient || !routeToHospital) {
        setDispatchNotice('Could not fetch a drivable road route right now. Please try again.');
        return;
      }

      setOpsState((prev) =>
        dispatchRequestToDriver(prev, requestId, driverId, routeToPatient, routeToHospital),
      );
      setSelectedRequestId(requestId);
      setSelectedDriverId(driverId);
      setClosestSuggestion(null);
      setDispatchNotice(`${mode === 'auto' ? 'Auto-dispatched' : 'Dispatched'} ${driver.callSign} -> ${request.id}.`);
    } finally {
      setIsResolvingRoute(false);
    }
  };

  const suggestClosestDriverForRequest = (requestId: string) => {
    const request = opsState.requests.find((r) => r.id === requestId);
    if (!request) {
      setDispatchNotice('Request no longer available.');
      return;
    }

    if (!(request.status === 'new' || request.status === 'triaged')) {
      setDispatchNotice('Only new or triaged requests can be allocated.');
      return;
    }

    if (availableDrivers.length === 0) {
      setSelectedRequestId(requestId);
      setSelectedDriverId(null);
      setClosestSuggestion(null);
      setDispatchNotice('No available drivers currently.');
      return;
    }

    const nearest = availableDrivers.reduce((best, current) => {
      const bestDistance = routeDistanceKm(buildRoadRoute(best.location, request.location));
      const currentDistance = routeDistanceKm(buildRoadRoute(current.location, request.location));
      return currentDistance < bestDistance ? current : best;
    }, availableDrivers[0]);

    const chosenDriver = loggedInAvailableDriver ?? nearest;

    const chosenRoute = buildRoadRoute(chosenDriver.location, request.location);
    const chosenDistanceKm = routeDistanceKm(chosenRoute);
    const chosenEta = Math.max(1, Math.round((chosenDistanceKm / Math.max(chosenDriver.speedKmph, 24)) * 60));

    const isLoggedInPrioritized = Boolean(loggedInAvailableDriver && loggedInAvailableDriver.id === chosenDriver.id);

    setSelectedRequestId(requestId);
    setSelectedDriverId(chosenDriver.id);
    setClosestSuggestion({
      requestId,
      driverId: chosenDriver.id,
      driverCallSign: chosenDriver.callSign,
      driverName: chosenDriver.name,
      distanceKm: chosenDistanceKm,
      etaMinutes: chosenEta,
    });

    if (isLoggedInPrioritized) {
      setDispatchNotice(
        `Logged-in nearby driver selected: ${chosenDriver.callSign} (${chosenDistanceKm.toFixed(1)} km).`,
      );
      return;
    }

    setDispatchNotice(`Closest driver selected: ${chosenDriver.callSign} (${chosenDistanceKm.toFixed(1)} km).`);
  };

  const handleAutoDispatchNearest = (requestId: string) => {
    suggestClosestDriverForRequest(requestId);
  };

  const handleDispatchSelected = () => {
    if (!selectedRequestId || !selectedDriverId) { setDispatchNotice('Select one request and one driver first.'); return; }
    void dispatchWithDriver(selectedRequestId, selectedDriverId, 'manual');
  };

  const handleBedAdjustment = (field: keyof HospitalBedState, delta: number, label: string) => {
    setOpsState((prev) => {
      const { nextBeds, changed } = adjustBeds(prev.hospital.beds, field, delta);
      if (!changed) return prev;
      const direction = delta > 0 ? 'increased' : 'decreased';
      return appendEvent(
        { ...prev, hospital: { ...prev.hospital, beds: nextBeds } },
        'capacity',
        `${label} ${direction}. Beds now ${nextBeds.occupiedBeds}/${nextBeds.totalBeds}.`,
      );
    });
  };

  const handleSectionChange = (section: HospitalSectionKey) => {
    setActiveSection(section);
    if (isMobileViewport()) setIsMobileNavOpen(false);
  };

  const handleSidebarToggle = () => {
    if (isMobileViewport()) { setIsMobileNavOpen((prev) => !prev); return; }
    setIsDesktopNavOpen((prev) => !prev);
  };

  const handleSidebarLogout = () => {
    if (isMobileViewport()) {
      setIsMobileNavOpen(false);
    }
    logoutHospitalUser();
  };

  // Close mobile nav on viewport resize to desktop
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia(MOBILE_NAV_QUERY);
    const handler = (e: MediaQueryListEvent) => { if (!e.matches) setIsMobileNavOpen(false); };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    }
    media.addListener(handler);
    return () => media.removeListener(handler);
  }, []);

  if (!isHospitalAuthenticated || !hospitalUser) {
    if (typeof window !== 'undefined') {
      window.location.hash = '/auth';
    }
    return null;
  }

  return (
    <main className={`hospital-dashboard${isDesktopNavOpen ? ' desktop-nav-open' : ''}${isMobileNavOpen ? ' mobile-nav-open' : ''}`}>

      {/* â”€â”€ Sidebar â”€â”€ */}
      <aside className={`hospital-sidebar${isMobileNavOpen ? ' is-open' : ''}`} aria-label="Hospital dashboard sections">
        <div className="hospital-sidebar-brand">
          <span className="hospital-sidebar-brand-mark" aria-hidden="true">CR</span>
          <div className="hospital-sidebar-brand-copy">
            <strong>Hospital Panel</strong>
            <span>CodeRed Navigation</span>
          </div>
        </div>


        <nav className="hospital-sidebar-nav" aria-label="Hospital controls navigation">
          {hospitalSections.map((section) => (
            <button
              key={section.key}
              type="button"
              className={`hospital-sidebar-item${activeSection === section.key ? ' active' : ''}`}
              onClick={() => handleSectionChange(section.key)}
              aria-current={activeSection === section.key ? 'page' : undefined}
              title={section.label}
            >
              <span className="hospital-sidebar-item-icon" aria-hidden="true">
                <section.icon size={18} strokeWidth={2.1} />
                {section.key === 'queue' && criticalCases > 0 && (
                  <span className="hospital-sidebar-item-pulse" />
                )}
              </span>
              <span className="hospital-sidebar-label">{section.label}</span>
            </button>
          ))}
        </nav>

        <button
          type="button"
          className="hospital-sidebar-logout"
          onClick={handleSidebarLogout}
          title={!isMobileViewport() && !isDesktopNavOpen ? 'Logout' : undefined}
        >
          <LogOut size={16} />
          {isMobileViewport() || isDesktopNavOpen ? 'Logout' : null}
        </button>



        {!isMobileViewport() && (
          <button
            type="button"
            className="hospital-sidebar-collapse"
            aria-label={isDesktopNavOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            onClick={handleSidebarToggle}
          >
            {isDesktopNavOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
        )}
      </aside>

      {/* Mobile backdrop */}
      <button
        type="button"
        className="hospital-sidebar-backdrop"
        aria-hidden={!isMobileNavOpen}
        aria-label="Close navigation"
        onClick={() => setIsMobileNavOpen(false)}
      />

      {/* Mobile menu toggle */}
      {isMobileViewport() && (
        <button
          type="button"
          className="hospital-mobile-menu-toggle"
          aria-label={isMobileNavOpen ? 'Close sidebar menu' : 'Open sidebar menu'}
          onClick={handleSidebarToggle}
        >
          {isMobileNavOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      )}

      {/* â”€â”€ Main content â”€â”€ */}
      <div className="hospital-content">
        <div className="hospital-content-inner">

          {/* â”€â”€ Header â”€â”€ */}
          <header className="hospital-head">
            <div className="hospital-head-main">
              <div className="hospital-head-icon-wrap" aria-hidden="true">
                <activeSectionMeta.icon size={24} strokeWidth={2.1} />
              </div>
              <div className="hospital-head-copy">
                <p className="hospital-eyebrow">{activeSectionMeta.label} Â· Hospital Operations Console</p>
                <h1>{opsState.hospital.name}</h1>
                <p>Live demo â€” real-time request intake, GPS ping simulation, fleet linkage and dispatch flow.</p>
                <p className="hospital-auth-meta">Signed in as {hospitalUser.email}</p>
              </div>
            </div>
            <div className="hospital-head-actions">
              <div className="hospital-head-meta">
                <span className="meta-pill">Section: {activeSectionMeta.label}</span>
                <span className="live-pill">Live Â· pings every {DRIVER_PING_SECONDS}s</span>
                <span className="meta-pill">Last tick {formatDate(opsState.lastSimulationAt)}</span>
              </div>
              <div className="hospital-head-buttons">
                <button type="button" className="btn btn-secondary" onClick={handleSimulateIncoming}>+ Simulate Request</button>
                <button type="button" className="btn btn-ghost" onClick={handleResetDemo}>Reset Demo</button>
              </div>
            </div>
          </header>

          {/* â”€â”€ Alerts â”€â”€ */}
          <div className="alert-stack">
            {bedPressure >= 0.9 && (
              <AlertBanner tone="danger" title="Bed occupancy critical" message="Capacity crossed 90%. Consider releasing beds or rerouting intake." actionLabel="Release 1 Bed" onAction={() => handleBedAdjustment('occupiedBeds', -1, 'Occupied beds')} />
            )}
            {criticalCases > 0 && (
              <AlertBanner tone="warning" title={`${criticalCases} critical case${criticalCases > 1 ? 's' : ''} in queue`} message="Prioritize triage and dispatch for high-acuity patients." />
            )}
            {dispatchNotice && <AlertBanner tone="info" title={dispatchNotice} />}
          </div>

          {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
              SECTION: DASHBOARD
          â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
          {activeSection === 'dashboard' && (
            <>
              {/* Readiness score banner */}
              <section className="hospital-performance-banner" aria-label="Hospital performance summary">
                <div className="hospital-performance-left">
                  <div className="hospital-performance-score-ring" aria-hidden="true">
                    <svg viewBox="0 0 120 120" className="hospital-score-svg">
                      <circle cx="60" cy="60" r="52" className="hospital-score-track" />
                      <circle cx="60" cy="60" r="52" className="hospital-score-value"
                        strokeDasharray={`${(dispatchReadinessScore / 100) * scoreRingCircumference} ${scoreRingCircumference}`} />
                    </svg>
                    <div className="hospital-score-copy">
                      <strong>{dispatchReadinessScore}</strong>
                      <span>Score</span>
                    </div>
                  </div>
                  <div className="hospital-performance-copy">
                    <h2>Dispatch Readiness</h2>
                    <p>Based on fleet availability, completion rate, bed occupancy and response velocity.</p>
                    <div className="hospital-performance-badges">
                      <span className="hospital-performance-badge">{openRequests.length} active requests</span>
                      <span className="hospital-performance-badge">{dispatchableRequests.length} dispatch pending</span>
                      <span className="hospital-performance-badge">{criticalCases} critical</span>
                    </div>
                  </div>
                </div>
                <div className="hospital-performance-metrics">
                  {[
                    { label: 'Fleet', value: availableFleetPct, tone: 'fleet' },
                    { label: 'Completion', value: completionRate, tone: 'completion' },
                    { label: 'Beds Free', value: Math.max(0, 100 - bedOccupancyPct), tone: 'beds' },
                  ].map((m) => (
                    <article key={m.label} className="hospital-performance-metric">
                      <div className="hospital-mini-ring" aria-hidden="true">
                        <svg viewBox="0 0 80 80">
                          <circle cx="40" cy="40" r="30" className="hospital-mini-ring-track" />
                          <circle cx="40" cy="40" r="30" className={`hospital-mini-ring-value tone-${m.tone}`}
                            strokeDasharray={`${(m.value / 100) * miniRingCircumference} ${miniRingCircumference}`} />
                        </svg>
                        <span>{m.value}%</span>
                      </div>
                      <p>{m.label}</p>
                    </article>
                  ))}
                </div>
              </section>

              {/* KPI cards */}
              <section className="hospital-kpi-grid" aria-label="Operations summary">
                <article className="kpi-card tone-danger">
                  <div className="kpi-card-headline"><p>Open Requests</p><span className="kpi-card-chip">Live Queue</span></div>
                  <strong>{openRequests.length}</strong>
                  <span className="kpi-card-caption">{dispatchableRequests.length} awaiting dispatch</span>
                </article>
                <article className="kpi-card tone-blue">
                  <div className="kpi-card-headline"><p>Fleet Linked</p><span className="kpi-card-chip">Ambulance Ops</span></div>
                  <strong>{linkedDrivers.length}</strong>
                  <span className="kpi-card-caption">{availableDrivers.length} available now</span>
                </article>
                <article className="kpi-card tone-amber">
                  <div className="kpi-card-headline"><p>Active Trips</p><span className="kpi-card-chip">Route Live</span></div>
                  <strong>{activeTrips}</strong>
                  <span className="kpi-card-caption">{avgEtaMinutes > 0 ? `Avg ETA ${avgEtaMinutes} min` : 'No active ETAs'}</span>
                </article>
                <article className="kpi-card tone-green">
                  <div className="kpi-card-headline"><p>Beds Available</p><span className="kpi-card-chip">Capacity</span></div>
                  <strong>{availableBeds}</strong>
                  <span className="kpi-card-caption">ICU {availableIcuBeds} / {opsState.hospital.beds.icuTotal}</span>
                </article>
              </section>

              {/* Dashboard insight grid */}
              <section className="hospital-dashboard-grid" aria-label="Dashboard analytics panels">
                <div className="dashboard-column">
                  <section className="hospital-panel dashboard-insight-panel">
                    <div className="panel-head"><h2>Queue Snapshot</h2><p>Highest-acuity patients currently waiting.</p></div>
                    {recentPriorityRequests.length === 0 ? (
                      <p className="empty-state">No open patient requests right now.</p>
                    ) : (
                      <div className="dashboard-priority-list">
                        {recentPriorityRequests.map((r) => (
                          <article key={r.id} className="dashboard-priority-item">
                            <div><strong>{r.id}</strong><p>{r.patientName} — {r.symptom}</p></div>
                            <div className="dashboard-priority-item-meta">
                              <StatusBadge label={r.severity} tone={severityTone[r.severity]} />
                              <span>{formatDate(r.reportedAt)}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    <button type="button" className="btn btn-primary" onClick={() => handleSectionChange('queue')}>Open Patient Queue</button>
                  </section>

                  <section className="hospital-panel dashboard-insight-panel">
                    <div className="panel-head"><h2>Capacity Pressure</h2><p>Real-time occupancy pressure against total bed stock.</p></div>
                    <div className="capacity-meter" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, Math.round(bedPressure * 100))}%` }} />
                    </div>
                    <p className="capacity-copy">{Math.round(bedPressure * 100)}% occupied — {availableBeds} beds and {availableIcuBeds} ICU beds available.</p>
                    <div className="capacity-actions">
                      <button type="button" className="btn btn-secondary" onClick={() => handleBedAdjustment('occupiedBeds', -1, 'Occupied beds')}>Release 1 Bed</button>
                      <button type="button" className="btn btn-primary" onClick={() => handleSectionChange('beds')}>Open Bed Manager</button>
                    </div>
                  </section>
                </div>

                <div className="dashboard-column">
                  <section className="hospital-panel dashboard-insight-panel">
                    <div className="panel-head"><h2>Fleet Health</h2><p>Availability, fuel, and connectivity at a glance.</p></div>
                    <dl className="dashboard-stat-grid">
                      <div><dt>Availability</dt><dd>{availableFleetPct}%</dd></div>
                      <div><dt>Offline Units</dt><dd>{offlineDrivers}</dd></div>
                      <div><dt>Low Fuel Units</dt><dd>{lowFuelDrivers}</dd></div>
                      <div><dt>Average Fuel</dt><dd>{averageFuelPct}%</dd></div>
                      <div><dt>Completed Cases</dt><dd>{completionRate}%</dd></div>
                      <div><dt>Active Trips</dt><dd>{activeTrips}</dd></div>
                    </dl>
                    <button type="button" className="btn btn-secondary" onClick={() => handleSectionChange('ambulance')}>Open Ambulance Dashboard</button>
                  </section>

                  <section className="timeline-panel" aria-label="Operations timeline">
                    <div className="panel-head compact"><h3>Ops Timeline</h3><p>Dispatch, triage and capacity events.</p></div>
                    <div className="timeline-list">
                      {opsState.events.slice(0, 12).map((event) => (
                        <article className="timeline-item" key={event.id}>
                          <div className="timeline-item-head">
                            <StatusBadge label={event.type} tone={eventTone(event.type)} />
                            <time>{formatDate(event.at)}</time>
                          </div>
                          <p>{event.message}</p>
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
              </section>
            </>
          )}

          {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
              SECTION: PATIENT QUEUE
          â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
          {activeSection === 'queue' && (
            <section className="hospital-queue-layout">
              <section className="hospital-panel request-panel">
                <div className="panel-head"><h2>Patient Queue</h2><p>Receive, triage, and dispatch.</p></div>
                <div className="request-filters" role="tablist" aria-label="Request filters" ref={requestFilterRef}>
                  <span
                    className="request-filters-indicator"
                    aria-hidden="true"
                    style={{
                      width: `${filterIndicatorStyle.width}px`,
                      transform: `translateX(${filterIndicatorStyle.left}px)`,
                      opacity: filterIndicatorStyle.visible ? 1 : 0,
                    }}
                  />
                  {requestFilters.map((f) => (
                    <button key={f.key} type="button" className={`filter-chip${requestFilter === f.key ? ' active' : ''}`} onClick={() => setRequestFilter(f.key)}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="request-list">
                  {filteredRequests.length === 0 ? (
                    <p className="empty-state">No requests for this filter.</p>
                  ) : (
                    filteredRequests.map((request) => (
                      <article
                        key={request.id}
                        className={`request-card${selectedRequestId === request.id ? ' selected' : ''}`}
                        onClick={() => setSelectedRequestId(request.id)}
                      >
                        <div className="request-card-head">
                          <div><h3>{request.id}</h3><p>{request.patientName}, {request.age} yrs</p></div>
                          <div className="request-card-badges">
                            <StatusBadge label={request.severity} tone={severityTone[request.severity]} />
                            <StatusBadge label={requestStatusLabel[request.status]} tone={requestStatusTone[request.status]} />
                          </div>
                        </div>
                        <p className="request-symptom">{request.symptom}</p>
                        <dl className="request-meta">
                          <div><dt>Address</dt><dd>{request.address}</dd></div>
                          <div><dt>Channel</dt><dd>{request.channel}</dd></div>
                          <div><dt>Reported</dt><dd>{formatDate(request.reportedAt)}</dd></div>
                        </dl>
                        <div className="request-actions" onClick={(e) => e.stopPropagation()}>
                          {request.status === 'new' && (
                            <button type="button" className="btn btn-secondary" onClick={() => handleTriageRequest(request.id)}>Triage</button>
                          )}
                          {(request.status === 'new' || request.status === 'triaged') && availableDrivers.length > 0 && (
                            <button type="button" className="btn btn-primary" onClick={() => handleAutoDispatchNearest(request.id)}>Auto Select Closest</button>
                          )}
                          <button type="button" className="btn btn-ghost" onClick={() => setSelectedRequestId(request.id)}>Track</button>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </section>

              <section className="hospital-panel map-panel">
                <div className="panel-head"><h2>Live Operations Map</h2><p>All linked drivers and active requests rendered live.</p></div>
                <div className="map-view-wrapper">
                  <MapView
                    hospital={opsState.hospital}
                    drivers={linkedDrivers}
                    requests={opsState.requests}
                    selectedDriverId={selectedDriverId}
                    selectedRequestId={selectedRequestId}
                    onSelectDriver={setSelectedDriverId}
                    onSelectRequest={setSelectedRequestId}
                    onSuggestClosestDriver={handleAutoDispatchNearest}
                    suggestedDriversByRequest={
                      closestSuggestion
                        ? { [closestSuggestion.requestId]: `${closestSuggestion.driverCallSign} (${closestSuggestion.distanceKm.toFixed(1)} km, ${closestSuggestion.etaMinutes} min)` }
                        : undefined
                    }
                  />
                </div>
                <section className="dispatch-console" aria-label="Dispatch console">
                  <h3>Dispatch Console</h3>
                  <div className="dispatch-fields">
                    <label>
                      Request
                      <select value={selectedRequestId ?? ''} onChange={(e) => setSelectedRequestId(e.target.value || null)}>
                        <option value="">Select request...</option>
                        {dispatchableRequests.map((r) => (
                          <option key={r.id} value={r.id}>{r.id} - {r.severity.toUpperCase()} - {r.address}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Driver
                      <select value={selectedDriverId ?? ''} onChange={(e) => setSelectedDriverId(e.target.value || null)}>
                        <option value="">Select driver...</option>
                        {availableDrivers.map((d) => (
                          <option key={d.id} value={d.id}>{d.callSign} - {d.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {closestSuggestion && selectedRequestId === closestSuggestion.requestId && (
                    <p className="closest-driver-note">
                      Closest driver selected: <strong>{closestSuggestion.driverCallSign}</strong> ({closestSuggestion.driverName}) -{' '}
                      {closestSuggestion.distanceKm.toFixed(1)} km - ETA {closestSuggestion.etaMinutes} min. Press <strong>Dispatch Selected Pair</strong> to proceed.
                    </p>
                  )}
                  <button type="button" className="btn btn-primary" onClick={handleDispatchSelected} disabled={!selectedRequest || !selectedDriver || isResolvingRoute}>
                    {isResolvingRoute ? 'Preparing Road Route...' : 'Dispatch Selected Pair'}
                  </button>
                </section>
              </section>
            </section>
          )}

          {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
              SECTION: AMBULANCE DASHBOARD
          â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
          {activeSection === 'ambulance' && (
            <>
              <section className="hospital-kpi-grid ambulance-kpi-grid" aria-label="Ambulance summary">
                <article className="kpi-card tone-blue">
                  <div className="kpi-card-headline"><p>Ambulances Linked</p><span className="kpi-card-chip">Roster</span></div>
                  <strong>{linkedDrivers.length}</strong>
                  <span className="kpi-card-caption">{availableDrivers.length} currently available</span>
                </article>
                <article className="kpi-card tone-green">
                  <div className="kpi-card-headline"><p>Availability</p><span className="kpi-card-chip">Uptime</span></div>
                  <strong>{availableFleetPct}%</strong>
                  <span className="kpi-card-caption">{offlineDrivers} units offline</span>
                </article>
                <article className="kpi-card tone-amber">
                  <div className="kpi-card-headline"><p>Active Trips</p><span className="kpi-card-chip">In Transit</span></div>
                  <strong>{activeTrips}</strong>
                  <span className="kpi-card-caption">{avgEtaMinutes > 0 ? `Avg ETA ${avgEtaMinutes} min` : 'No active ETAs'}</span>
                </article>
                <article className="kpi-card tone-danger">
                  <div className="kpi-card-headline"><p>Fleet Fuel</p><span className="kpi-card-chip">Efficiency</span></div>
                  <strong>{averageFuelPct}%</strong>
                  <span className="kpi-card-caption">{lowFuelDrivers} low-fuel units</span>
                </article>
              </section>

              <section className="hospital-panel ambulance-dashboard-panel" aria-label="Ambulance roster">
                <div className="panel-head"><h2>Ambulance Dashboard</h2><p>Driver assignment, fuel, speed and GPS ping status for every linked unit.</p></div>
                <div className="driver-list driver-list--expanded">
                  {linkedDrivers.map((driver) => (
                    <article key={driver.id} className={`driver-card${selectedDriverId === driver.id ? ' selected' : ''}`}>
                      <div className="driver-card-head">
                        <div><h4>{driver.callSign}</h4><p>{driver.name}</p></div>
                        <div className="driver-badges">
                          <StatusBadge label={driverStatusLabel[driver.status]} tone={driverStatusTone[driver.status]} />
                          <StatusBadge label={driver.occupied ? 'Occupied' : 'Empty'} tone={driver.occupied ? 'danger' : 'success'} />
                        </div>
                      </div>
                      <dl className="driver-meta">
                        <div><dt>Vehicle</dt><dd>{driver.vehicleNumber}</dd></div>
                        <div><dt>Fuel</dt><dd>{Math.round(driver.fuelPct)}%</dd></div>
                        <div><dt>Speed</dt><dd>{Math.round(driver.speedKmph)} km/h</dd></div>
                        <div><dt>Ping</dt><dd>{formatPingAge(driver.lastPingAt)} ago</dd></div>
                      </dl>
                      <div className="driver-actions">
                        <button type="button" className="btn btn-ghost" onClick={() => setSelectedDriverId(driver.id)}>Focus</button>
                        {selectedRequest && driver.status === 'available' && !driver.occupied && (
                          <button type="button" className="btn btn-secondary" onClick={() => { void dispatchWithDriver(selectedRequest.id, driver.id, 'manual'); }} disabled={isResolvingRoute}>
                            Dispatch Here
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}

          {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
              SECTION: BED MANAGER
          â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
          {activeSection === 'beds' && (
            <section className="hospital-bed-layout">
              <aside className="hospital-panel side-panel">
                <div className="panel-head"><h2>Bed Manager</h2><p>Adjust occupancy and ICU availability in real time.</p></div>
                <section className="bed-card">
                  <div className="bed-row">
                    <div><p>Total Beds</p><strong>{opsState.hospital.beds.totalBeds}</strong></div>
                    <div className="stepper">
                      <button type="button" onClick={() => handleBedAdjustment('totalBeds', -1, 'Total beds')}>âˆ’</button>
                      <button type="button" onClick={() => handleBedAdjustment('totalBeds', 1, 'Total beds')}>+</button>
                    </div>
                  </div>
                  <div className="bed-row">
                    <div><p>Occupied</p><strong>{opsState.hospital.beds.occupiedBeds}</strong></div>
                    <div className="stepper">
                      <button type="button" onClick={() => handleBedAdjustment('occupiedBeds', -1, 'Occupied beds')}>Release</button>
                      <button type="button" onClick={() => handleBedAdjustment('occupiedBeds', 1, 'Occupied beds')}>Occupy</button>
                    </div>
                  </div>
                  <div className="bed-row">
                    <div><p>ICU Total</p><strong>{opsState.hospital.beds.icuTotal}</strong></div>
                    <div className="stepper">
                      <button type="button" onClick={() => handleBedAdjustment('icuTotal', -1, 'ICU total')}>âˆ’</button>
                      <button type="button" onClick={() => handleBedAdjustment('icuTotal', 1, 'ICU total')}>+</button>
                    </div>
                  </div>
                  <div className="bed-row">
                    <div><p>ICU Occupied</p><strong>{opsState.hospital.beds.icuOccupied}</strong></div>
                    <div className="stepper">
                      <button type="button" onClick={() => handleBedAdjustment('icuOccupied', -1, 'ICU occupied')}>Release</button>
                      <button type="button" onClick={() => handleBedAdjustment('icuOccupied', 1, 'ICU occupied')}>Occupy</button>
                    </div>
                  </div>
                </section>
              </aside>

              <section className="timeline-panel" aria-label="Capacity timeline">
                <div className="panel-head compact"><h3>Capacity Timeline</h3><p>Bed updates and capacity actions from operators.</p></div>
                <div className="timeline-list">
                  {capacityEvents.length === 0 ? (
                    <p className="empty-state">No bed-capacity changes recorded yet.</p>
                  ) : (
                    capacityEvents.slice(0, 14).map((event) => (
                      <article className="timeline-item" key={event.id}>
                        <div className="timeline-item-head">
                          <StatusBadge label={event.type} tone={eventTone(event.type)} />
                          <time>{formatDate(event.at)}</time>
                        </div>
                        <p>{event.message}</p>
                      </article>
                    ))
                  )}
                </div>
              </section>
            </section>
          )}

        </div>
      </div>
    </main>
  );
}
