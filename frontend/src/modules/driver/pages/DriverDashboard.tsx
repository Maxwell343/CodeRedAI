import { useCallback, useEffect, useMemo, useState } from 'react';
import Map, { Layer, Marker, NavigationControl, Source, type LayerProps } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';

import { useHospitalAuth } from '@shared/providers/AuthContext';
import { DriverLayout } from './DriverLayout';
import { resolveDriverUnitId } from '../utils/driverIdentity';
import type {
  DispatchOffer,
  DriverStatus,
  GeoPoint,
  HospitalLocationRef,
  HospitalOpsState,
  OpsEvent,
  PatientRequest,
} from '@shared/types/hospitalOps.types';
import { createInitialHospitalOpsState, isDemoHospitalAccount } from '@shared/utils/hospitalDemoData';
import { buildRoadRoute, distanceKm, fetchRoadRouteFromApi, routeDistanceKm } from '@shared/utils/hospitalOpsSimulator';
import {
  fetchDriverStats,
  fetchActiveMission,
  type DriverStats,
  type ActiveMission,
} from '@shared/utils/driverOpsApi';
import './DriverDashboard.css';

type StatusTone = 'danger' | 'warning' | 'success' | 'neutral';

type ActivityItem = {
  time: string;
  message: string;
};

const INITIAL_FEED: ActivityItem[] = [
  { time: '14:34', message: 'Dispatched by Admin. Mission started.' },
  { time: '14:35', message: 'Route calculated. ETA 18 min.' },
  { time: '14:36', message: 'Hospital Kokilaben confirmed readiness.' },
  { time: '14:37', message: 'Bystander CPR in progress at pickup.' },
];

type RouteStop = {
  id: 'current' | 'pickup' | 'hospital';
  title: string;
  subtitle: string;
  eta: string;
  coordinates: [number, number];
};

const STORAGE_KEY_PREFIX = 'codered-hospital-demo-v3';
const DEFAULT_HOSPITAL_ID = 'HSP-MUM-009';
const DEFAULT_POINT: GeoPoint = { lat: 19.1178, lng: 72.8781 };
const DISPATCH_OFFER_SECONDS = 60;

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || '';

const routeGlowLayer: LayerProps = {
  id: 'driver-route-glow',
  type: 'line',
  paint: {
    'line-color': '#2b7bff',
    'line-width': 10,
    'line-opacity': 0.18,
  },
};

const routeLineLayer: LayerProps = {
  id: 'driver-route-main',
  type: 'line',
  layout: {
    'line-cap': 'round',
    'line-join': 'round',
  },
  paint: {
    'line-color': '#58a6ff',
    'line-width': 4,
    'line-dasharray': [2, 1.4],
  },
};

const buildingExtrusionLayer: LayerProps = {
  id: 'driver-3d-buildings',
  type: 'fill-extrusion',
  source: 'composite',
  'source-layer': 'building',
  minzoom: 10.5,
  filter: ['==', 'extrude', 'true'],
  paint: {
    'fill-extrusion-color': '#d7e1ee',
    'fill-extrusion-opacity': 0.5,
    'fill-extrusion-height': [
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      0,
      14,
      ['coalesce', ['get', 'height'], 10],
    ],
    'fill-extrusion-base': [
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      0,
      14,
      ['coalesce', ['get', 'min_height'], 0],
    ],
  },
};

function stateStorageKey(hospitalId: string) {
  return `${STORAGE_KEY_PREFIX}-${hospitalId}`;
}

function isHospitalOpsState(candidate: unknown): candidate is HospitalOpsState {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const value = candidate as Partial<HospitalOpsState>;

  return Boolean(
    value.hospital &&
      Array.isArray(value.drivers) &&
      Array.isArray(value.requests) &&
      Array.isArray(value.events) &&
      typeof value.nextRequestNumber === 'number',
  );
}

function loadOpsStateByKey(key: string): HospitalOpsState | null {
  if (typeof window === 'undefined') {
    return null;

  }

  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isHospitalOpsState(parsed)) {
      return {
        ...parsed,
        pendingDispatchOffers: Array.isArray(parsed.pendingDispatchOffers) ? parsed.pendingDispatchOffers : [],
      };
    }
  } catch {
    return null;
  }

  return null;
}

function resolveLatestOpsStorageKey(preferredHospitalId?: string, preferredDriverId?: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (preferredHospitalId) {
    const preferredKey = stateStorageKey(preferredHospitalId);
    if (window.localStorage.getItem(preferredKey)) {
      return preferredKey;
    }
  }

  const allKeys = Object.keys(window.localStorage).filter((key) => key.startsWith(STORAGE_KEY_PREFIX));
  if (allKeys.length === 0) {
    return null;
  }

  const candidates = allKeys
    .map((key) => {
      const state = loadOpsStateByKey(key);
      return {
        key,
        state,
        tickAt: state ? Date.parse(state.lastSimulationAt) : 0,
      };
    })
    .sort((left, right) => right.tickAt - left.tickAt);

  if (preferredDriverId) {
    const keyForDriver = candidates.find((candidate) =>
      candidate.state?.drivers.some((driver) => driver.id === preferredDriverId),
    );

    if (keyForDriver) {
      return keyForDriver.key;
    }
  }

  return candidates[0]?.key ?? null;
}

function formatClock(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatEventTime(isoTime: string) {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }

  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function estimateEtaMinutes(distanceKmValue: number, speedKmph: number) {
  if (speedKmph <= 0) {
    return undefined;
  }

  return Math.max(1, Math.round((distanceKmValue / speedKmph) * 60));
}

function roundedRoutePoint(point: GeoPoint, decimals = 3): GeoPoint {
  const scale = 10 ** decimals;
  return {
    lat: Math.round(point.lat * scale) / scale,
    lng: Math.round(point.lng * scale) / scale,
  };
}

function missionLabelFromDriver(driverStatus: DriverStatus | undefined, request: PatientRequest | null) {
  if (request?.status === 'completed') {
    return 'Arrived';
  }

  if (driverStatus === 'to_patient') {
    return 'En Route to Patient';
  }

  if (driverStatus === 'with_patient') {
    return 'Patient Onboard';
  }

  if (driverStatus === 'to_hospital') {
    return 'En Route to Hospital';
  }

  return 'Dispatched';
}

function missionTone(label: string): StatusTone {
  if (label === 'Arrived') {
    return 'success';
  }

  if (label === 'Patient Onboard') {
    return 'warning';
  }

  if (label.includes('En Route')) {
    return 'danger';
  }

  return 'neutral';
}

function goldenTone(remainingSeconds: number): StatusTone {
  if (remainingSeconds <= 10 * 60) {
    return 'danger';
  }

  if (remainingSeconds <= 30 * 60) {
    return 'warning';
  }

  return 'success';
}

function isDispatchableOfferRequest(request: PatientRequest | null) {
  return Boolean(request && (request.status === 'new' || request.status === 'triaged'));
}

function isDispatchOfferDriverAvailable(driverStatus: DriverStatus | undefined, occupied: boolean | undefined) {
  return Boolean(driverStatus === 'available' && !occupied);
}

function offerSecondsLeft(offer: DispatchOffer, nowMs: number) {
  const expiresAtMs = Date.parse(offer.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return 0;
  }

  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

function appendEvent(
  state: HospitalOpsState,
  eventType: OpsEvent['type'],
  message: string,
  requestId?: string,
  driverId?: string,
): HospitalOpsState {
  const nowIso = new Date().toISOString();
  const event: OpsEvent = {
    id: `EVT-${Date.now()}-${Math.floor(Math.random() * 100_000)}`,
    at: nowIso,
    type: eventType,
    message,
    requestId,
    driverId,
  };

  return {
    ...state,
    events: [event, ...state.events].slice(0, 60),
    lastSimulationAt: nowIso,
  };
}

function buildDefaultStops(
  currentPoint: GeoPoint,
  pickupPoint: GeoPoint,
  hospitalPoint: GeoPoint,
  pickupTitle: string,
  pickupSubtitle: string,
  hospitalTitle: string,
  pickupEta: string,
  hospitalEta: string,
): RouteStop[] {
  return [
    {
      id: 'current',
      title: 'Current Vehicle Position',
      subtitle: 'Live ambulance GPS',
      eta: 'Now',
      coordinates: [currentPoint.lng, currentPoint.lat],
    },
    {
      id: 'pickup',
      title: pickupTitle,
      subtitle: pickupSubtitle,
      eta: pickupEta,
      coordinates: [pickupPoint.lng, pickupPoint.lat],
    },
    {
      id: 'hospital',
      title: hospitalTitle,
      subtitle: 'Drop destination',
      eta: hospitalEta,
      coordinates: [hospitalPoint.lng, hospitalPoint.lat],
    },
  ];
}

export function DriverDashboard() {
  const {
    driverUser,
    isDriverAuthenticated,
    logoutDriverUser,
  } = useHospitalAuth();

  const [opsStorageKey, setOpsStorageKey] = useState<string | null>(null);
  const [opsState, setOpsState] = useState<HospitalOpsState | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: StatusTone } | null>(null);
  const [alertStrip, setAlertStrip] = useState<string | null>(null);
  const [isRouteClear, setIsRouteClear] = useState(true);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [isAcceptingDispatchOffer, setIsAcceptingDispatchOffer] = useState(false);

  // Real-time API stats
  const [apiStats, setApiStats] = useState<DriverStats | null>(null);
  const [apiActiveMission, setApiActiveMission] = useState<ActiveMission | null>(null);

  useEffect(() => {
    if (!driverUser?.email) return;
    const loadApiData = async () => {
      try {
        const [statsRes, missionRes] = await Promise.all([
          fetchDriverStats(driverUser.email),
          fetchActiveMission(driverUser.email),
        ]);
        if (statsRes.success) setApiStats(statsRes);
        if (missionRes.success) setApiActiveMission(missionRes.mission);
      } catch {}
    };
    void loadApiData();
    const id = window.setInterval(loadApiData, 10_000);
    return () => window.clearInterval(id);
  }, [driverUser?.email]);

  const syncLinkedState = useCallback(() => {
    if (!isDriverAuthenticated) {
      setOpsStorageKey(null);
      setOpsState(null);
      setSelectedDriverId(null);
      return;
    }

    const resolvedKey = resolveLatestOpsStorageKey(
      driverUser?.linkedHospitalId ?? DEFAULT_HOSPITAL_ID,
      driverUser?.id,
    );

    if (!resolvedKey) {
      setOpsStorageKey(null);
      setOpsState(null);
      setSelectedDriverId(null);
      return;
    }

    const parsed = loadOpsStateByKey(resolvedKey);
    if (!parsed) {
      return;
    }

    setOpsStorageKey(resolvedKey);
    setOpsState(parsed);
    setSelectedDriverId((previousDriverId) =>
      resolveDriverUnitId({
        driverUser,
        drivers: parsed.drivers,
        previousDriverId,
      }),
    );
  }, [driverUser, isDriverAuthenticated]);

  useEffect(() => {
    syncLinkedState();

    const intervalId = window.setInterval(() => {
      syncLinkedState();
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [syncLinkedState]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key || !event.key.startsWith(STORAGE_KEY_PREFIX)) {
        return;
      }

      syncLinkedState();
    };

    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [syncLinkedState]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToast(null);
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    if (!alertStrip) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAlertStrip(null);
    }, 2200);

    return () => window.clearTimeout(timeoutId);
  }, [alertStrip]);

  const linkedDrivers = opsState?.drivers ?? [];
  const pendingDispatchOffers = opsState?.pendingDispatchOffers ?? [];
  const authenticatedDriverUnitId = useMemo(
    () => resolveDriverUnitId({ driverUser, drivers: linkedDrivers }),
    [driverUser, linkedDrivers],
  );
  const selectableDrivers = useMemo(() => {
    if (!authenticatedDriverUnitId) {
      return linkedDrivers;
    }

    const ownDriver = linkedDrivers.find((driver) => driver.id === authenticatedDriverUnitId);
    return ownDriver ? [ownDriver] : linkedDrivers;
  }, [authenticatedDriverUnitId, linkedDrivers]);
  const pendingOfferCountForDriver = useMemo(() => {
    if (!authenticatedDriverUnitId) {
      return 0;
    }

    return pendingDispatchOffers.filter((offer) => offer.offeredDriverId === authenticatedDriverUnitId).length;
  }, [authenticatedDriverUnitId, pendingDispatchOffers]);
  const selectedDriver = useMemo(
    () => linkedDrivers.find((driver) => driver.id === selectedDriverId) ?? null,
    [linkedDrivers, selectedDriverId],
  );

  const dispatchOffer = useMemo(() => {
    if (!opsState || !authenticatedDriverUnitId) {
      return null;
    }

    const offersForDriver = pendingDispatchOffers
      .filter((offer) => offer.offeredDriverId === authenticatedDriverUnitId)
      .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));

    for (const offer of offersForDriver) {
      const request = opsState.requests.find((candidate) => candidate.id === offer.requestId) ?? null;
      const driver = opsState.drivers.find((candidate) => candidate.id === offer.offeredDriverId) ?? null;

      if (!isDispatchableOfferRequest(request)) {
        continue;
      }

      if (!isDispatchOfferDriverAvailable(driver?.status, driver?.occupied)) {
        continue;
      }

      if (offerSecondsLeft(offer, nowTick) <= 0) {
        continue;
      }

      return offer;
    }

    return null;
  }, [authenticatedDriverUnitId, nowTick, opsState, pendingDispatchOffers]);

  const dispatchOfferRequest = useMemo(() => {
    if (!opsState || !dispatchOffer) {
      return null;
    }

    return opsState.requests.find((request) => request.id === dispatchOffer.requestId) ?? null;
  }, [dispatchOffer, opsState]);

  const dispatchOfferDriver = useMemo(() => {
    if (!opsState || !dispatchOffer) {
      return null;
    }

    return opsState.drivers.find((driver) => driver.id === dispatchOffer.offeredDriverId) ?? null;
  }, [dispatchOffer, opsState]);

  const dispatchOfferSecondsRemaining = useMemo(
    () => (dispatchOffer ? offerSecondsLeft(dispatchOffer, nowTick) : 0),
    [dispatchOffer, nowTick],
  );

  const activeRequest = useMemo(() => {
    if (!opsState || !selectedDriver) {
      return null;
    }

    if (selectedDriver.assignment?.requestId) {
      const request =
        opsState.requests.find((candidate) => candidate.id === selectedDriver.assignment?.requestId) ?? null;
      if (request && request.status !== 'completed' && request.status !== 'cancelled') {
        return request;
      }

      return null;
    }

    return (
      opsState.requests.find(
        (request) =>
          request.assignedDriverId === selectedDriver.id &&
          request.status !== 'cancelled' &&
          request.status !== 'completed',
      ) ?? null
    );
  }, [opsState, selectedDriver]);

  const missionLabel = missionLabelFromDriver(selectedDriver?.status, activeRequest);
  const statusTone = missionTone(missionLabel);
  const pickupMarked = useMemo(
    () => Boolean(activeRequest?.notes?.toLowerCase().includes('patient picked')),
    [activeRequest?.notes],
  );

  const missionSeconds = useMemo(() => {
    if (!activeRequest) {
      return 0;
    }

    const missionStart = Date.parse(activeRequest.reportedAt);
    if (Number.isNaN(missionStart)) {
      return 0;
    }

    const missionEnd = activeRequest.closedAt ? Date.parse(activeRequest.closedAt) : nowTick;
    return Math.max(0, Math.floor((missionEnd - missionStart) / 1000));
  }, [activeRequest, nowTick]);

  const goldenRemainingSeconds = useMemo(() => {
    if (!activeRequest) {
      return 60 * 60;
    }

    return Math.max(0, 60 * 60 - missionSeconds);
  }, [activeRequest, missionSeconds]);

  const goldenStatusTone = goldenTone(goldenRemainingSeconds);

  const currentPoint = selectedDriver?.location ?? opsState?.hospital.location ?? DEFAULT_POINT;
  const pickupPoint = activeRequest?.location ?? currentPoint;
  const hospitalPoint = opsState?.hospital.location ?? DEFAULT_POINT;

  const hasAuthoritativeOpsRoute = useMemo(() => {
    if (!selectedDriver?.assignment) {
      return false;
    }

    const assignment = selectedDriver.assignment;
    if (assignment.stage === 'to_patient') {
      return Boolean(assignment.route && assignment.route.length > 1);
    }

    if (assignment.stage === 'with_patient') {
      return Boolean(assignment.hospitalRoute && assignment.hospitalRoute.length > 1);
    }

    if (assignment.stage === 'to_hospital') {
      return Boolean(
        (assignment.route && assignment.route.length > 1) ||
          (assignment.hospitalRoute && assignment.hospitalRoute.length > 1),
      );
    }

    return false;
  }, [selectedDriver]);

  const baseRoutePoints = useMemo(() => {
    if (!selectedDriver) {
      return buildRoadRoute(currentPoint, hospitalPoint);
    }

    const assignment = selectedDriver.assignment;

    if (assignment?.stage === 'to_patient') {
      if (assignment.route && assignment.route.length > 1) {
        const routeTail = assignment.route.slice(Math.max(1, assignment.routeIndex ?? 1));
        return [currentPoint, ...routeTail];
      }

      if (activeRequest) {
        return buildRoadRoute(currentPoint, activeRequest.location);
      }
    }

    if (assignment?.stage === 'with_patient') {
      if (assignment.hospitalRoute && assignment.hospitalRoute.length > 1) {
        return [currentPoint, ...assignment.hospitalRoute.slice(1)];
      }

      return buildRoadRoute(currentPoint, hospitalPoint);
    }

    if (assignment?.stage === 'to_hospital') {
      if (assignment.route && assignment.route.length > 1) {
        const routeTail = assignment.route.slice(Math.max(1, assignment.routeIndex ?? 1));
        return [currentPoint, ...routeTail];
      }

      if (assignment.hospitalRoute && assignment.hospitalRoute.length > 1) {
        return [currentPoint, ...assignment.hospitalRoute.slice(1)];
      }

      return buildRoadRoute(currentPoint, hospitalPoint);
    }

    if (activeRequest && activeRequest.status !== 'completed' && activeRequest.status !== 'cancelled') {
      return buildRoadRoute(currentPoint, activeRequest.location);
    }

    return buildRoadRoute(currentPoint, hospitalPoint);
  }, [activeRequest, currentPoint, hospitalPoint, selectedDriver]);

  const snapDestination = useMemo(() => {
    if (
      missionLabel === 'En Route to Patient' ||
      missionLabel === 'Dispatched' ||
      (activeRequest && activeRequest.status !== 'completed' && activeRequest.status !== 'cancelled')
    ) {
      return pickupPoint;
    }

    return hospitalPoint;
  }, [activeRequest, hospitalPoint, missionLabel, pickupPoint]);

  const snapStart = useMemo(
    () => roundedRoutePoint(currentPoint, 3),
    [currentPoint.lat, currentPoint.lng],
  );

  const snapEnd = useMemo(
    () => roundedRoutePoint(snapDestination, 3),
    [snapDestination.lat, snapDestination.lng],
  );

  const [apiSnappedRoutePoints, setApiSnappedRoutePoints] = useState<GeoPoint[] | null>(null);

  useEffect(() => {
    let isDisposed = false;

    if (hasAuthoritativeOpsRoute) {
      setApiSnappedRoutePoints(null);
      return () => {
        isDisposed = true;
      };
    }

    if (distanceKm(snapStart, snapEnd) < 0.05) {
      setApiSnappedRoutePoints([
        { lat: currentPoint.lat, lng: currentPoint.lng },
        { lat: snapDestination.lat, lng: snapDestination.lng },
      ]);
      return () => {
        isDisposed = true;
      };
    }

    void fetchRoadRouteFromApi(snapStart, snapEnd)
      .then((route) => {
        if (isDisposed) {
          return;
        }

        if (!route || route.length < 2) {
          setApiSnappedRoutePoints(null);
          return;
        }

        const stitchedRoute: GeoPoint[] = [
          { lat: currentPoint.lat, lng: currentPoint.lng },
          ...route.slice(1, -1),
          { lat: snapDestination.lat, lng: snapDestination.lng },
        ];

        setApiSnappedRoutePoints(stitchedRoute);
      })
      .catch(() => {
        if (!isDisposed) {
          setApiSnappedRoutePoints(null);
        }
      });

    return () => {
      isDisposed = true;
    };
  }, [
    currentPoint.lat,
    currentPoint.lng,
    hasAuthoritativeOpsRoute,
    snapDestination.lat,
    snapDestination.lng,
    snapEnd,
    snapStart,
  ]);

  const routePoints = useMemo(
    () =>
      !hasAuthoritativeOpsRoute && apiSnappedRoutePoints && apiSnappedRoutePoints.length > 1
        ? apiSnappedRoutePoints
        : baseRoutePoints,
    [apiSnappedRoutePoints, baseRoutePoints, hasAuthoritativeOpsRoute],
  );

  const routeGeoJson = useMemo(() => {
    const coordinates = routePoints.map((point) => [point.lng, point.lat] as [number, number]);
    const lineCoordinates = coordinates.length > 1 ? coordinates : [coordinates[0], coordinates[0]];

    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: lineCoordinates,
      },
    };
  }, [routePoints]);

  const mapCenter = useMemo(() => {
    const points = [currentPoint, pickupPoint, hospitalPoint];
    const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
    const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
    return { lat, lng };
  }, [currentPoint, pickupPoint, hospitalPoint]);

  const speedKmph = selectedDriver?.speedKmph ?? 36;

  const pickupDistanceKm = activeRequest ? distanceKm(currentPoint, pickupPoint) : 0;
  const hospitalDistanceKm = distanceKm(currentPoint, hospitalPoint);

  const pickupEtaMinutes =
    missionLabel === 'En Route to Patient'
      ? selectedDriver?.etaMinutes ?? estimateEtaMinutes(pickupDistanceKm, speedKmph)
      : missionLabel === 'Patient Onboard' || missionLabel === 'En Route to Hospital' || missionLabel === 'Arrived'
        ? 0
        : estimateEtaMinutes(pickupDistanceKm, speedKmph);

  const hospitalEtaMinutes =
    missionLabel === 'En Route to Hospital'
      ? selectedDriver?.etaMinutes ?? estimateEtaMinutes(hospitalDistanceKm, speedKmph)
      : missionLabel === 'Patient Onboard'
        ? estimateEtaMinutes(hospitalDistanceKm, speedKmph)
        : missionLabel === 'Arrived'
          ? 0
          : undefined;

  const distanceRemainingKm =
    missionLabel === 'En Route to Hospital' || missionLabel === 'Patient Onboard'
      ? hospitalDistanceKm
      : missionLabel === 'En Route to Patient'
        ? pickupDistanceKm
        : routeDistanceKm(routePoints);

  const canMarkArrive = Boolean(
    activeRequest &&
      selectedDriver &&
      selectedDriver.status === 'to_hospital' &&
      pickupMarked,
  );

  const feedItems = useMemo<ActivityItem[]>(() => {
    if (!opsState || !selectedDriver) {
      return INITIAL_FEED;
    }

    const relevant = opsState.events
      .filter((event) => {
        if (event.driverId === selectedDriver.id) {
          return true;
        }

        if (activeRequest && event.requestId === activeRequest.id) {
          return true;
        }

        return false;
      })
      .slice(0, 4)
      .map((event) => ({
        time: formatEventTime(event.at),
        message: event.message,
      }));

    return relevant.length > 0 ? relevant : INITIAL_FEED;
  }, [activeRequest, opsState, selectedDriver]);

  const updateLinkedState = (nextState: HospitalOpsState) => {
    if (!opsStorageKey || typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(opsStorageKey, JSON.stringify(nextState));
    setOpsState(nextState);
  };

  const handleAcceptDispatchOffer = async () => {
    if (!opsState || !dispatchOffer || !dispatchOfferRequest || !dispatchOfferDriver) {
      setToast({ message: 'No valid dispatch offer available.', tone: 'warning' });
      return;
    }

    if (dispatchOfferSecondsRemaining <= 0) {
      setToast({ message: 'Dispatch offer already expired.', tone: 'warning' });
      return;
    }

    if (!isDispatchOfferDriverAvailable(dispatchOfferDriver.status, dispatchOfferDriver.occupied)) {
      setToast({ message: 'Driver unit is no longer available for this request.', tone: 'warning' });
      return;
    }

    setIsAcceptingDispatchOffer(true);

    try {
      const [routeToPatientFromApi, routeToHospitalFromApi] = await Promise.all([
        fetchRoadRouteFromApi(dispatchOfferDriver.location, dispatchOfferRequest.location),
        fetchRoadRouteFromApi(dispatchOfferRequest.location, opsState.hospital.location),
      ]);

      const routeToPatient =
        routeToPatientFromApi.length > 1
          ? routeToPatientFromApi
          : buildRoadRoute(dispatchOfferDriver.location, dispatchOfferRequest.location);

      const routeToHospital =
        routeToHospitalFromApi.length > 1
          ? routeToHospitalFromApi
          : buildRoadRoute(dispatchOfferRequest.location, opsState.hospital.location);

      const nowIso = new Date().toISOString();
      const etaToPatient = estimateEtaMinutes(
        routeDistanceKm(routeToPatient),
        Math.max(dispatchOfferDriver.speedKmph, 24),
      );

      const nextDrivers = opsState.drivers.map((driver) => {
        if (driver.id !== dispatchOfferDriver.id) {
          return driver;
        }

        return {
          ...driver,
          status: 'to_patient' as const,
          occupied: false,
          assignment: {
            requestId: dispatchOfferRequest.id,
            stage: 'to_patient' as const,
            stageTicks: 0,
            route: routeToPatient,
            routeIndex: 1,
            hospitalRoute: routeToHospital,
          },
          etaMinutes: etaToPatient,
          lastPingAt: nowIso,
          secondsSincePing: 0,
        };
      });

      const nextRequests = opsState.requests.map((request) => {
        if (request.id !== dispatchOfferRequest.id) {
          return request;
        }

        return {
          ...request,
          status: 'dispatched' as const,
          assignedDriverId: dispatchOfferDriver.id,
          hospitalId: opsState.hospital.id,
          notes: `${request.notes ? `${request.notes} | ` : ''}Dispatch accepted by ${dispatchOfferDriver.callSign}.`,
        };
      });

      let nextState: HospitalOpsState = {
        ...opsState,
        drivers: nextDrivers,
        requests: nextRequests,
        pendingDispatchOffers: (opsState.pendingDispatchOffers ?? []).filter(
          (offer) => offer.requestId !== dispatchOfferRequest.id,
        ),
        lastSimulationAt: nowIso,
      };

      nextState = appendEvent(
        nextState,
        'dispatch',
        `${dispatchOfferDriver.callSign} accepted dispatch request for ${dispatchOfferRequest.id}.`,
        dispatchOfferRequest.id,
        dispatchOfferDriver.id,
      );

      updateLinkedState(nextState);
      setSelectedDriverId(dispatchOfferDriver.id);
      setToast({ message: `Dispatch accepted for ${dispatchOfferRequest.id}.`, tone: 'success' });
    } catch {
      setToast({ message: 'Unable to accept dispatch request right now. Please retry.', tone: 'warning' });
    } finally {
      setIsAcceptingDispatchOffer(false);
    }
  };

  const handleToggleRoute = () => {
    setIsRouteClear((prev) => !prev);
  };

  const handleResetDemo = () => {
    if (!opsStorageKey || !opsState) {
      setToast({ message: 'No linked demo state available.', tone: 'warning' });
      return;
    }

    const hospitalRef: HospitalLocationRef = {
      id: opsState.hospital.id,
      name: opsState.hospital.name,
      address: opsState.hospital.address,
      phone: opsState.hospital.phone,
      location: { ...opsState.hospital.location },
    };

    const isDemo = isDemoHospitalAccount(hospitalRef.id, driverUser?.email);
    const resetState = createInitialHospitalOpsState(hospitalRef, isDemo);
    updateLinkedState(resetState);
    setSelectedDriverId((previousDriverId) =>
      resolveDriverUnitId({
        driverUser,
        drivers: resetState.drivers,
        previousDriverId,
      }),
    );
    setAlertStrip(null);
    setToast({ message: 'Demo data reset to baseline.', tone: 'success' });
  };

  const handleNotifyHospital = () => {
    if (opsState && selectedDriver && activeRequest) {
      const nextState = appendEvent(
        opsState,
        'system',
        `${selectedDriver.callSign} sent pre-arrival update for ${activeRequest.id}.`,
        activeRequest.id,
        selectedDriver.id,
      );
      updateLinkedState(nextState);
    }

    setToast({ message: 'Hospital notified successfully', tone: 'success' });
  };

  const handleRequestBackup = () => {
    if (opsState && selectedDriver && activeRequest) {
      const nextState = appendEvent(
        opsState,
        'system',
        `${selectedDriver.callSign} requested backup support for ${activeRequest.id}.`,
        activeRequest.id,
        selectedDriver.id,
      );
      updateLinkedState(nextState);
    }

    setToast({ message: 'Backup request sent to dispatch', tone: 'warning' });
  };

  const handleSos = () => {
    if (opsState && selectedDriver) {
      const nextState = appendEvent(
        opsState,
        'system',
        `SOS triggered by ${selectedDriver.callSign}. Immediate dispatch escalation required.`,
        activeRequest?.id,
        selectedDriver.id,
      );
      updateLinkedState(nextState);
    }

    setAlertStrip('SOS sent to dispatch');
  };

  const handleMarkPicked = async () => {
    if (!opsState || !selectedDriver || !activeRequest) {
      setToast({ message: 'No active pickup route available.', tone: 'warning' });
      return;
    }

    if (selectedDriver.status === 'to_hospital') {
      setToast({ message: 'Patient already picked. Transport in progress.', tone: 'warning' });
      return;
    }

    if (selectedDriver.status !== 'to_patient') {
      setToast({ message: 'Driver must be en route to patient before pickup.', tone: 'warning' });
      return;
    }

    const nowIso = new Date().toISOString();

    const routedToHospital = await fetchRoadRouteFromApi(activeRequest.location, opsState.hospital.location);

    const hospitalRoute =
      routedToHospital.length > 1
        ? routedToHospital
        : selectedDriver.assignment?.hospitalRoute && selectedDriver.assignment.hospitalRoute.length > 1
          ? selectedDriver.assignment.hospitalRoute
          : buildRoadRoute(activeRequest.location, opsState.hospital.location);

    const etaToHospital = estimateEtaMinutes(
      routeDistanceKm(hospitalRoute),
      Math.max(selectedDriver.speedKmph, 24),
    );

    const nextDrivers = opsState.drivers.map((driver) => {
      if (driver.id !== selectedDriver.id) {
        return driver;
      }

      return {
        ...driver,
        status: 'to_hospital' as const,
        occupied: true,
        location: { ...activeRequest.location },
        etaMinutes: etaToHospital,
        assignment: {
          requestId: activeRequest.id,
          stage: 'to_hospital' as const,
          stageTicks: 0,
          route: hospitalRoute,
          routeIndex: 1,
          hospitalRoute,
        },
        lastPingAt: nowIso,
        secondsSincePing: 0,
      };
    });

    const nextRequests = opsState.requests.map((request) => {
      if (request.id !== activeRequest.id) {
        return request;
      }

      return {
        ...request,
        status: 'dispatched' as const,
        assignedDriverId: selectedDriver.id,
        hospitalId: opsState.hospital.id,
        notes: `${request.notes ? `${request.notes} | ` : ''}Patient picked. Transport to hospital started.`,
      };
    });

    let nextState: HospitalOpsState = {
      ...opsState,
      drivers: nextDrivers,
      requests: nextRequests,
      lastSimulationAt: nowIso,
    };

    nextState = appendEvent(
      nextState,
      'dispatch',
      `${selectedDriver.callSign} picked patient for ${activeRequest.id} and started transport to hospital.`,
      activeRequest.id,
      selectedDriver.id,
    );

    updateLinkedState(nextState);
    setToast({ message: 'Patient marked picked. Routing to hospital.', tone: 'success' });
  };

  const handleMarkArrived = () => {
    if (!opsState || !selectedDriver || !activeRequest) {
      setToast({ message: 'No active mission to complete.', tone: 'warning' });
      return;
    }

    if (!pickupMarked) {
      setToast({ message: 'Mark patient picked before arrival.', tone: 'warning' });
      return;
    }

    const nowIso = new Date().toISOString();

    const nextDrivers = opsState.drivers.map((driver) => {
      if (driver.id !== selectedDriver.id) {
        return driver;
      }

      return {
        ...driver,
        status: 'available' as const,
        occupied: false,
        location: { ...opsState.hospital.location },
        assignment: undefined,
        etaMinutes: undefined,
        lastPingAt: nowIso,
        secondsSincePing: 0,
      };
    });

    const nextRequests = opsState.requests.map((request) => {
      if (request.id !== activeRequest.id) {
        return request;
      }

      return {
        ...request,
        status: 'completed' as const,
        closedAt: nowIso,
        hospitalId: opsState.hospital.id,
        notes: `${request.notes ? `${request.notes} | ` : ''}Driver marked arrival from driver dashboard.`,
      };
    });

    const nextBeds = {
      ...opsState.hospital.beds,
      occupiedBeds: Math.min(opsState.hospital.beds.totalBeds, opsState.hospital.beds.occupiedBeds + 1),
      icuOccupied:
        activeRequest.severity === 'critical'
          ? Math.min(opsState.hospital.beds.icuTotal, opsState.hospital.beds.icuOccupied + 1)
          : opsState.hospital.beds.icuOccupied,
    };

    let nextState: HospitalOpsState = {
      ...opsState,
      hospital: {
        ...opsState.hospital,
        beds: nextBeds,
      },
      drivers: nextDrivers,
      requests: nextRequests,
      lastSimulationAt: nowIso,
    };

    nextState = appendEvent(
      nextState,
      'handover',
      `${selectedDriver.callSign} completed handover for ${activeRequest.id}.`,
      activeRequest.id,
      selectedDriver.id,
    );

    updateLinkedState(nextState);
    setToast({ message: 'Mission marked as arrived', tone: 'success' });
  };

  const handleStatusAdvance = async () => {
    if (!opsState || !selectedDriver) {
      setToast({ message: 'Waiting for linked hospital state.', tone: 'warning' });
      return;
    }

    if (selectedDriver.status === 'offline') {
      setToast({ message: 'Driver unit is offline.', tone: 'warning' });
      return;
    }

    if (!activeRequest || activeRequest.status === 'completed' || activeRequest.status === 'cancelled') {
      setToast({ message: 'No active request assigned by hospital.', tone: 'warning' });
      return;
    }

    if (selectedDriver.status === 'to_hospital') {
      if (!pickupMarked) {
        setToast({ message: 'Use Mark Picked before marking arrival.', tone: 'warning' });
        return;
      }

      handleMarkArrived();
      return;
    }

    const nowIso = new Date().toISOString();
    let nextDriver = selectedDriver;
    let nextRequest = activeRequest;
    let eventType: OpsEvent['type'] = 'dispatch';
    let eventMessage = '';

    if (selectedDriver.status === 'available') {
      const [routeToPatientFromApi, routeToHospitalFromApi] = await Promise.all([
        fetchRoadRouteFromApi(selectedDriver.location, activeRequest.location),
        fetchRoadRouteFromApi(activeRequest.location, opsState.hospital.location),
      ]);

      const routeToPatient =
        routeToPatientFromApi.length > 1
          ? routeToPatientFromApi
          : buildRoadRoute(selectedDriver.location, activeRequest.location);

      const routeToHospital =
        routeToHospitalFromApi.length > 1
          ? routeToHospitalFromApi
          : buildRoadRoute(activeRequest.location, opsState.hospital.location);

      const etaToPatient = estimateEtaMinutes(routeDistanceKm(routeToPatient), Math.max(selectedDriver.speedKmph, 24));

      nextDriver = {
        ...selectedDriver,
        status: 'to_patient',
        occupied: false,
        assignment: {
          requestId: activeRequest.id,
          stage: 'to_patient',
          stageTicks: 0,
          route: routeToPatient,
          routeIndex: 1,
          hospitalRoute: routeToHospital,
        },
        etaMinutes: etaToPatient,
        lastPingAt: nowIso,
        secondsSincePing: 0,
      };

      nextRequest = {
        ...activeRequest,
        status: 'dispatched',
        assignedDriverId: selectedDriver.id,
        hospitalId: opsState.hospital.id,
      };

      eventMessage = `${selectedDriver.callSign} confirmed dispatch to ${activeRequest.id}.`;
    }

    if (selectedDriver.status === 'to_patient') {
      nextDriver = {
        ...selectedDriver,
        status: 'with_patient',
        occupied: true,
        location: { ...activeRequest.location },
        etaMinutes: 0,
        assignment: {
          ...selectedDriver.assignment!,
          stage: 'with_patient',
          stageTicks: 0,
          route: undefined,
          routeIndex: undefined,
          hospitalRoute:
            selectedDriver.assignment?.hospitalRoute && selectedDriver.assignment.hospitalRoute.length > 1
              ? selectedDriver.assignment.hospitalRoute
              : buildRoadRoute(activeRequest.location, opsState.hospital.location),
        },
        lastPingAt: nowIso,
        secondsSincePing: 0,
      };

      eventType = 'arrival';
      eventMessage = `${selectedDriver.callSign} reached ${activeRequest.id} pickup point.`;
    }

    if (selectedDriver.status === 'with_patient') {
      const routeToHospital =
        selectedDriver.assignment?.hospitalRoute && selectedDriver.assignment.hospitalRoute.length > 1
          ? selectedDriver.assignment.hospitalRoute
          : buildRoadRoute(activeRequest.location, opsState.hospital.location);

      const etaToHospital = estimateEtaMinutes(routeDistanceKm(routeToHospital), Math.max(selectedDriver.speedKmph, 24));

      nextDriver = {
        ...selectedDriver,
        status: 'to_hospital',
        occupied: true,
        etaMinutes: etaToHospital,
        assignment: {
          ...selectedDriver.assignment!,
          stage: 'to_hospital',
          stageTicks: 0,
          route: routeToHospital,
          routeIndex: 1,
          hospitalRoute: routeToHospital,
        },
        lastPingAt: nowIso,
        secondsSincePing: 0,
      };

      eventType = 'dispatch';
      eventMessage = `${selectedDriver.callSign} started transport of ${activeRequest.id} to hospital.`;
    }

    const nextDrivers = opsState.drivers.map((driver) => (driver.id === selectedDriver.id ? nextDriver : driver));
    const nextRequests = opsState.requests.map((request) => (request.id === nextRequest.id ? nextRequest : request));

    let nextState: HospitalOpsState = {
      ...opsState,
      drivers: nextDrivers,
      requests: nextRequests,
      lastSimulationAt: nowIso,
    };

    nextState = appendEvent(nextState, eventType, eventMessage, activeRequest.id, selectedDriver.id);
    updateLinkedState(nextState);
  };

  const canMarkPick = Boolean(
    activeRequest &&
      selectedDriver &&
      selectedDriver.status === 'to_patient' &&
      !pickupMarked,
  );

  const transportActionLabel = pickupMarked ? 'Mark Arrived' : 'Mark Picked';
  const transportActionHandler = pickupMarked ? handleMarkArrived : handleMarkPicked;
  const transportActionEnabled = pickupMarked ? canMarkArrive : canMarkPick;
  const transportActionClassName = pickupMarked
    ? 'quick-btn quick-btn-success'
    : 'quick-btn quick-btn-info';
  const transportActionTitle = pickupMarked
    ? canMarkArrive
      ? 'Mark arrival at hospital'
      : 'Pickup complete. Continue transport to hospital before arrival.'
    : canMarkPick
      ? 'Mark patient pickup and switch route to hospital'
      : 'Driver must be en route to patient to pick up';

  if (!isDriverAuthenticated || !driverUser) {
    if (typeof window !== 'undefined') {
      window.location.hash = '/auth';
    }
    return null;
  }

  const missionActive = Boolean(
    selectedDriver &&
      (selectedDriver.status === 'to_patient' ||
        selectedDriver.status === 'with_patient' ||
        selectedDriver.status === 'to_hospital'),
  );

  const routeConditionLabel = isRouteClear ? 'Clear' : 'Delay';

  const routeStops = buildDefaultStops(
    currentPoint,
    pickupPoint,
    hospitalPoint,
    activeRequest?.address ?? 'Awaiting assignment',
    activeRequest ? `Patient ${activeRequest.id}` : 'No dispatch from hospital yet',
    opsState?.hospital.name ?? 'Destination Hospital',
    pickupEtaMinutes === undefined ? '--' : `${pickupEtaMinutes} min`,
    hospitalEtaMinutes === undefined ? '--' : `${hospitalEtaMinutes} min`,
  );

  return (
    <DriverLayout missionActive={missionActive} pickupCount={pendingOfferCountForDriver} onLogout={logoutDriverUser}>
      <main className="driver-console">
      <header className="driver-head">
        <div className="driver-head-copy">
          <p className="driver-eyebrow">Driver Operations Console</p>
          <h1>LIVE MISSIONS</h1>
          <p>
            Linked with hospital dispatch state. Driver location, assigned patient pickup, and drop destination stay in
            sync.
          </p>
        </div>

        <div className="driver-head-meta">
          <span className="meta-pill mono">Signed in: {driverUser.email}</span>
          <span className="meta-pill mono">Hospital: {opsState?.hospital.name ?? 'Not linked'}</span>
          <span className="meta-pill mono">Storage: {opsStorageKey ? 'Connected' : 'Waiting'}</span>
          <label className="driver-select-wrap">
            <span>Driver Unit</span>
            <select
              className="driver-select"
              value={selectedDriverId ?? ''}
              disabled={Boolean(authenticatedDriverUnitId)}
              onChange={(event) => setSelectedDriverId(event.target.value || null)}
            >
              {selectableDrivers.length === 0 ? <option value="">No drivers</option> : null}
              {selectableDrivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.callSign} ({driver.status})
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-secondary" onClick={handleResetDemo}>
            Reset Demo
          </button>
        </div>
      </header>

      {dispatchOffer && dispatchOfferRequest && dispatchOfferDriver ? (
        <section className="dispatch-offer-card" aria-label="Incoming dispatch request">
          <div className="dispatch-offer-head">
            <p className="dispatch-offer-eyebrow">Dispatch Request</p>
            <span className="dispatch-offer-timer mono">{formatClock(dispatchOfferSecondsRemaining)}</span>
          </div>

          <div className="dispatch-offer-grid">
            <p>
              <strong>{dispatchOfferRequest.id}</strong> · {dispatchOfferRequest.severity.toUpperCase()}
            </p>
            <p>{dispatchOfferRequest.address}</p>
            <p>{dispatchOfferRequest.symptom}</p>
            <p className="dispatch-offer-meta">Offered to {dispatchOfferDriver.callSign} for {DISPATCH_OFFER_SECONDS}s.</p>
          </div>

          <button
            type="button"
            className="dispatch-offer-accept"
            onClick={() => {
              void handleAcceptDispatchOffer();
            }}
            disabled={isAcceptingDispatchOffer || dispatchOfferSecondsRemaining <= 0}
          >
            {isAcceptingDispatchOffer ? 'Accepting...' : 'Accept Dispatch'}
          </button>
        </section>
      ) : null}

      <section className="driver-kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }} aria-label="Mission snapshot">
        {/* Real-time stats from Backend */}
        <article className="kpi-card">
          <p>Missions Today</p>
          <strong>{apiStats?.completedMissions ?? '--'}</strong>
          <span>{apiStats ? `${apiStats.successRate}% Success` : 'Syncing...'}</span>
        </article>
        <article className="kpi-card">
          <p>Earnings</p>
          <strong className="mono">₹{apiStats?.totalEarnings?.toLocaleString('en-IN') ?? '--'}</strong>
          <span>Total accumulated</span>
        </article>
        
        {/* Local Ops State */}
        <article className="kpi-card">
          <p>Status</p>
          <strong>{apiActiveMission ? 'Ongoing Mission' : missionLabel}</strong>
          <span>{apiActiveMission ? `Request ${apiActiveMission.emergency_id}` : (activeRequest ? `Request ${activeRequest.id}` : 'Waiting for assignment')}</span>
        </article>
        <article className="kpi-card">
          <p>Mission Timer</p>
          <strong className="mono">{formatClock(missionSeconds)}</strong>
          <span>{activeRequest?.closedAt ? 'Frozen at arrival' : 'Counting from request intake'}</span>
        </article>
        <article className="kpi-card">
          <p>Golden Hour</p>
          <strong className="mono">{formatClock(goldenRemainingSeconds)}</strong>
          <span>
            {goldenStatusTone === 'danger'
              ? 'Critical threshold'
              : goldenStatusTone === 'warning'
                ? 'Under 30 minutes'
                : 'Within safe window'}
          </span>
        </article>
        <article className="kpi-card">
          <p>Distance Remaining</p>
          <strong className="mono">{distanceRemainingKm.toFixed(1)} km</strong>
          <span>Route is {routeConditionLabel.toLowerCase()}</span>
        </article>
      </section>

      <section className="driver-layout">
        <section className="driver-panel nav-panel" aria-label="Navigation and route panel">
          <div className="panel-head">
            <h2>Live Mission Map</h2>
            <button
              type="button"
              className={`route-badge ${isRouteClear ? 'route-clear' : 'route-delay'}`}
              onClick={handleToggleRoute}
            >
              {routeConditionLabel}
            </button>
          </div>

          <div className="map-surface">
            {MAPBOX_TOKEN ? (
              <Map
                key={`${selectedDriver?.id ?? 'none'}-${activeRequest?.id ?? 'none'}`}
                initialViewState={{
                  longitude: mapCenter.lng,
                  latitude: mapCenter.lat,
                  zoom: 12.2,
                  pitch: 52,
                  bearing: -16,
                }}
                mapboxAccessToken={MAPBOX_TOKEN}
                mapStyle="mapbox://styles/mapbox/navigation-day-v1"
                attributionControl={false}
                pitchWithRotate
                dragRotate
                maxPitch={70}
                style={{ width: '100%', height: '100%' }}
              >
                <NavigationControl position="top-right" />

                <Layer {...buildingExtrusionLayer} />

                <Source id="driver-route-source" type="geojson" data={routeGeoJson}>
                  <Layer {...routeGlowLayer} />
                  <Layer {...routeLineLayer} />
                </Source>

                {routeStops.map((stop) => (
                  <Marker
                    key={stop.id}
                    longitude={stop.coordinates[0]}
                    latitude={stop.coordinates[1]}
                    anchor="center"
                  >
                    <span className={`map-pin map-pin-${stop.id}`} aria-label={stop.title} />
                  </Marker>
                ))}
              </Map>
            ) : (
              <div className="map-token-warning" role="note">
                <p className="mono">Mapbox token missing.</p>
                <p>Set VITE_MAPBOX_ACCESS_TOKEN in your frontend environment to enable live map rendering.</p>
              </div>
            )}
          </div>

          <div className="route-track" aria-label="Route stops and ETAs">
            {routeStops.map((stop) => (
              <article className="route-step" key={stop.id}>
                <span className={`route-dot route-dot-${stop.id}`} aria-hidden="true" />
                <div>
                  <p className="route-step-title">{stop.title}</p>
                  <p className="route-step-meta">
                    {stop.subtitle} - ETA <span className="mono">{stop.eta}</span>
                  </p>
                </div>
              </article>
            ))}
          </div>

          <div className="route-actions">
            <a className="btn btn-ghost" href={`tel:${opsState?.hospital.phone ?? '+912233445566'}`}>
              Call Hospital
            </a>
          </div>
        </section>

        <section className="driver-panel mission-panel" aria-label="Mission and quick actions">
          <section className="mission-header-card">
            <div className="mission-row">
              <div>
                <p className="section-label">Ambulance ID</p>
                <p className="mono strong">{selectedDriver?.callSign ?? 'AMB-07'}</p>
              </div>
              <div className="right-align">
                <p className="section-label">Driver</p>
                <p className="strong">{selectedDriver?.name ?? 'Rajan Mehta'}</p>
              </div>
            </div>

            <div className="mission-row status-row">
              <button className={`status-pill status-pill-${statusTone}`} type="button" onClick={handleStatusAdvance}>
                <span>{missionLabel}</span>
                {missionLabel.includes('En Route') ? <span className="pulse-dot" aria-hidden="true" /> : null}
              </button>

              <div className="timer-block" aria-label="Mission timer">
                <p className="section-label">Mission Timer</p>
                <p className="mono timer-value">{formatClock(missionSeconds)}</p>
              </div>
            </div>
          </section>

          <section className="patient-card" aria-label="Patient details">
            <div className="patient-grid">
              <div>
                <p className="section-label">Patient ID</p>
                <p className="mono strong">{activeRequest?.id ?? 'P-2041'}</p>
              </div>
              <div>
                <p className="section-label">Age and Gender</p>
                <p className="mono strong">{activeRequest ? `${activeRequest.age}Y` : '54M'}</p>
              </div>
            </div>

            <p className="section-label">Chief Complaint</p>
            <p className="body-text">{activeRequest?.symptom ?? 'Waiting for hospital dispatch assignment.'}</p>

            <div className="patient-meta">
              <span className="badge badge-danger">{activeRequest?.severity?.toUpperCase() ?? 'CRITICAL'}</span>
              <span className={`badge badge-${goldenStatusTone}`}>
                Golden Hour: <span className="mono">{formatClock(goldenRemainingSeconds)}</span>
              </span>
            </div>

            <p className="dispatch-note">
              Dispatcher note:
              <span>
                {' '}
                {activeRequest?.notes ?? 'Patient is conscious. Awaiting real-time note from hospital dispatch.'}
              </span>
            </p>
          </section>

          <section className="quick-actions" aria-label="Quick actions">
            <button type="button" className="quick-btn quick-btn-sos" onClick={handleSos}>
              SOS
            </button>
            <button type="button" className="quick-btn" onClick={handleNotifyHospital}>
              Notify Hospital
            </button>
            <button type="button" className="quick-btn quick-btn-warning" onClick={handleRequestBackup}>
              Request Backup
            </button>
            <button
              type="button"
              className={transportActionClassName}
              onClick={transportActionHandler}
              disabled={!transportActionEnabled}
              title={transportActionTitle}
            >
              {transportActionLabel}
            </button>
          </section>

          <section className="activity-card" aria-label="Activity feed">
            <p className="section-label">Activity Feed</p>
            <ul>
              {feedItems.map((entry, index) => (
                <li key={`${entry.time}-${entry.message}-${index}`}>
                  <span className="mono">{entry.time}</span>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ul>
          </section>
        </section>
      </section>

      <div className="feedback-layer" aria-live="polite">
        {alertStrip ? (
          <aside className="status-strip status-strip-danger" role="alert">
            {alertStrip}
          </aside>
        ) : null}

        {toast ? (
          <aside className={`status-strip status-strip-${toast.tone}`} role="status">
            {toast.message}
          </aside>
        ) : null}
      </div>
      </main>
    </DriverLayout>
  );
}
