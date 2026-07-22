import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Crosshair, Maximize2, Pause, PhoneCall, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import Map, {
  Layer,
  Marker,
  NavigationControl,
  Source,
  type LayerProps,
  type MapRef,
} from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';

import { NavigationPanel } from '@/components/driver/NavigationPanel';
import { useDriverDispatch } from '@/hooks/useDriverDispatch';
import { useDriverSimulation } from '@/hooks/useDriverSimulation';
import { useVoiceNavigation } from '@/hooks/useVoiceNavigation';
import { useHospitalAuth } from '@shared/providers/AuthContext';
import type { DriverStatus, HospitalOpsState, PatientRequest } from '@shared/types/hospitalOps.types';
import { DriverLayout } from './DriverLayout';
import { resolveDriverUnitId } from '../utils/driverIdentity';

type ActiveLeg = 'to_pickup' | 'to_hospital' | 'arrived';
type MissionStatusValue = DriverStatus | PatientRequest['status'] | 'picked_up';

interface MissionCoordinates {
  id: string;
  patientId: string;
  patientAge: number;
  complaint: string;
  driverLocation: { lat: number; lng: number };
  pickupLocation: { lat: number; lng: number; address: string };
  hospitalLocation: { lat: number; lng: number; name: string; address: string };
}

interface RouteStep {
  instruction: string;
  distance: number;
  duration: number;
  maneuver: {
    type: string;
    modifier?: string;
    instruction: string;
    location?: [number, number];
  };
  voiceInstructions: { distanceAlongGeometry: number; announcement: string }[];
  bannerInstructions: {
    distanceAlongGeometry: number;
    primary: { text: string; type: string; modifier?: string };
    secondary?: { text: string };
  }[];
}

interface NavigationRoute {
  coordinates: [number, number][];
  steps: RouteStep[];
  etaSeconds: number;
  remainingDistanceMeters: number;
  loadedAt: number;
  leg: Exclude<ActiveLeg, 'arrived'>;
}

interface MapboxDirectionsStep {
  distance?: number;
  duration?: number;
  maneuver?: {
    type?: string;
    modifier?: string;
    instruction?: string;
    location?: [number, number];
  };
  voiceInstructions?: { distanceAlongGeometry: number; announcement: string }[];
  bannerInstructions?: {
    distanceAlongGeometry: number;
    primary: { text: string; type: string; modifier?: string };
    secondary?: { text: string };
  }[];
}

interface MapboxDirectionsLeg {
  distance?: number;
  duration?: number;
  steps?: MapboxDirectionsStep[];
}

interface MapboxDirectionsRoute {
  distance?: number;
  duration?: number;
  geometry?: { coordinates?: [number, number][] };
  legs?: MapboxDirectionsLeg[];
}

interface MapboxDirectionsResponse {
  routes?: MapboxDirectionsRoute[];
}

interface NearestHospital {
  name: string;
  address: string;
  lng: number;
  lat: number;
}

interface MapboxGeocodingFeature {
  text?: string;
  place_name?: string;
  center?: [number, number];
}

interface MapboxGeocodingResponse {
  features?: MapboxGeocodingFeature[];
}

const STORAGE_KEY_PREFIX = 'codered-hospital-demo-v3';
const DEFAULT_HOSPITAL_ID = 'HSP-MUM-009';
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || '';
const TURN_ANNOUNCE_200_METERS = 200;
const TURN_ANNOUNCE_50_METERS = 50;
const ARRIVAL_METERS = 30;
const REROUTE_METERS = 50;
const FAST_SIMULATION_INTERVAL_MS = 1000;
const FAST_SIMULATION_TARGET_LEG_SECONDS = 30;

const routeLineLayer: LayerProps = {
  id: 'live-mission-route-main',
  type: 'line',
  layout: {
    'line-cap': 'round',
    'line-join': 'round',
  },
  paint: {
    'line-color': '#ef4444',
    'line-width': 5,
    'line-opacity': 0.96,
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

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function distanceMeters(from: [number, number], to: [number, number]) {
  const earthRadius = 6371000;
  const dLat = toRadians(to[1] - from[1]);
  const dLng = toRadians(to[0] - from[0]);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from[1])) * Math.cos(toRadians(to[1])) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function buildDirectionsUrl(params: {
  origin: [number, number];
  pickup: [number, number];
  destination: [number, number];
  activeLeg: ActiveLeg;
  token: string;
}) {
  const { origin, pickup, destination, activeLeg, token } = params;
  const waypoints =
    activeLeg === 'to_hospital'
      ? `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`
      : `${origin[0]},${origin[1]};${pickup[0]},${pickup[1]}`;

  const search = new URLSearchParams({
    steps: 'true',
    voice_instructions: 'true',
    banner_instructions: 'true',
    voice_units: 'metric',
    geometries: 'geojson',
    overview: 'full',
    access_token: token,
  });

  return `https://api.mapbox.com/directions/v5/mapbox/driving/${waypoints}?${search.toString()}`;
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

async function fetchDirectionsRoute(params: {
  token: string;
  origin: [number, number];
  pickup: [number, number];
  destination: [number, number];
  activeLeg: ActiveLeg;
  signal: AbortSignal;
}): Promise<NavigationRoute> {
  const response = await fetch(
    buildDirectionsUrl({
      origin: params.origin,
      pickup: params.pickup,
      destination: params.destination,
      activeLeg: params.activeLeg,
      token: params.token,
    }),
    { signal: params.signal },
  );

  if (!response.ok) {
    throw new Error('Mapbox directions request failed');
  }

  const payload = (await response.json()) as MapboxDirectionsResponse;
  const route = payload.routes?.[0];
  if (!route?.geometry?.coordinates || route.geometry.coordinates.length < 2) {
    throw new Error('Directions route unavailable');
  }

  const legs = Array.isArray(route.legs) ? route.legs : [];
  const legIndex = params.activeLeg === 'to_pickup' ? 0 : Math.max(0, legs.length - 1);
  const activeLeg = legs[legIndex] ?? legs[0];
  const rawSteps = activeLeg?.steps ?? [];

  const steps: RouteStep[] = rawSteps.map((step) => {
    const voiceInstructions = Array.isArray(step.voiceInstructions) ? step.voiceInstructions : [];
    const bannerInstructions = Array.isArray(step.bannerInstructions) ? step.bannerInstructions : [];
    const maneuverInstruction = step.maneuver?.instruction || bannerInstructions[0]?.primary?.text || 'Continue';

    return {
      instruction: maneuverInstruction,
      distance: step.distance ?? 0,
      duration: step.duration ?? 0,
      maneuver: {
        type: step.maneuver?.type ?? 'continue',
        modifier: step.maneuver?.modifier,
        instruction: maneuverInstruction,
        location:
          Array.isArray(step.maneuver?.location) &&
          isFiniteCoordinate(step.maneuver?.location?.[0]) &&
          isFiniteCoordinate(step.maneuver?.location?.[1])
            ? [step.maneuver.location[0], step.maneuver.location[1]]
            : undefined,
      },
      voiceInstructions,
      bannerInstructions,
    };
  });

  return {
    coordinates: route.geometry.coordinates,
    steps,
    etaSeconds: Math.round(activeLeg?.duration ?? route.duration ?? 0),
    remainingDistanceMeters: activeLeg?.distance ?? route.distance ?? 0,
    loadedAt: Date.now(),
    leg: params.activeLeg === 'to_hospital' ? 'to_hospital' : 'to_pickup',
  };
}

async function fetchNearestHospital(params: {
  token: string;
  proximity: [number, number];
  signal: AbortSignal;
}): Promise<NearestHospital> {
  const [lng, lat] = params.proximity;
  const search = new URLSearchParams({
    proximity: `${lng},${lat}`,
    limit: '1',
    access_token: params.token,
  });

  const response = await fetch(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/hospital.json?${search.toString()}`,
    { signal: params.signal },
  );

  if (!response.ok) {
    throw new Error('Nearest hospital lookup failed');
  }

  const payload = (await response.json()) as MapboxGeocodingResponse;
  const feature = payload.features?.[0];
  const center = feature?.center;

  if (
    !feature ||
    !feature.text ||
    !feature.place_name ||
    !Array.isArray(center) ||
    !isFiniteCoordinate(center[0]) ||
    !isFiniteCoordinate(center[1])
  ) {
    throw new Error('No nearby hospital found');
  }

  return {
    name: feature.text,
    address: feature.place_name,
    lng: center[0],
    lat: center[1],
  };
}

function emptyState(message: string) {
  return (
    <section
      style={{
        border: '1px solid #e2e8f0',
        background: '#ffffff',
        borderRadius: '14px',
        padding: '24px',
        color: '#1e293b',
      }}
    >
      <h2 style={{ margin: 0, fontSize: '20px', color: '#0f172a' }}>Live Mission</h2>
      <p style={{ margin: '8px 0 0', color: '#475569' }}>{message}</p>
    </section>
  );
}

function mapBackendStatusToMissionStatus(status: string | undefined): MissionStatusValue | null {
  if (!status) {
    return null;
  }

  if (status === 'COMPLETED') {
    return 'completed';
  }

  if (
    status === 'PATIENT_PICKED' ||
    status === 'HOSPITAL_ASSIGNED' ||
    status === 'EN_ROUTE_HOSPITAL'
  ) {
    return 'picked_up';
  }

  if (status === 'DRIVER_ASSIGNED' || status === 'EN_ROUTE_PATIENT') {
    return 'to_patient';
  }

  return null;
}

export function LiveMission() {
  const {
    isDriverAuthenticated,
    driverUser,
    logoutDriverUser,
  } = useHospitalAuth();
  const driverDispatchId = driverUser?.email;
  const {
    pendingOffers: apiPendingOffers,
    activeMission: apiActiveMission,
    acceptOffer,
    rejectOffer,
    updateStatus,
  } = useDriverDispatch(driverDispatchId);

  const [opsStorageKey, setOpsStorageKey] = useState<string | null>(null);
  const [opsState, setOpsState] = useState<HospitalOpsState | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [routeData, setRouteData] = useState<NavigationRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [isLoadingRoute, setIsLoadingRoute] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [navStepIndex, setNavStepIndex] = useState(0);
  const [missionStatusOverride, setMissionStatusOverride] = useState<'picked_up' | null>(null);
  const [nearestHospital, setNearestHospital] = useState<NearestHospital | null>(null);
  const [isResolvingNearestHospital, setIsResolvingNearestHospital] = useState(false);
  const [isCompletingMission, setIsCompletingMission] = useState(false);
  const [preferApiDispatchMode, setPreferApiDispatchMode] = useState(false);
  const [completionSummary, setCompletionSummary] = useState<{ id: string } | null>(null);

  // Real GPS tracking
  const [realGpsPosition, setRealGpsPosition] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setRealGpsPosition([pos.coords.longitude, pos.coords.latitude]);
      },
      (err) => console.error('GPS error:', err),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Update backend every 5 seconds if we have a real GPS and active API mission
  useEffect(() => {
    if (!realGpsPosition || !apiActiveMission?.emergency_id || !driverDispatchId) return;
    const intervalId = window.setInterval(() => {
      void updateStatus(apiActiveMission.emergency_id, apiActiveMission.status, realGpsPosition[1], realGpsPosition[0]);
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [realGpsPosition, apiActiveMission, updateStatus, driverDispatchId]);

  const mapRef = useRef<MapRef | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const nearestHospitalLookupRef = useRef<AbortController | null>(null);
  const lastMissionIdRef = useRef<string | null>(null);
  const lastFetchRef = useRef<{ origin: [number, number]; leg: Exclude<ActiveLeg, 'arrived'>; missionId: string } | null>(
    null,
  );

  const announced200Ref = useRef<Set<number>>(new Set());
  const announced50Ref = useRef<Set<number>>(new Set());
  const straightAnnouncedRef = useRef<Set<number>>(new Set());
  const pickupArrivalAnnouncedRef = useRef(false);
  const hospitalArrivalAnnouncedRef = useRef(false);
  const missionCompleteAnnouncedRef = useRef(false);

  const { speak, voiceEnabled, setVoiceEnabled, supportsSpeech } = useVoiceNavigation();

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
    }, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
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
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }

      if (nearestHospitalLookupRef.current) {
        nearestHospitalLookupRef.current.abort();
        nearestHospitalLookupRef.current = null;
      }
    };
  }, []);

  const linkedDrivers = opsState?.drivers ?? [];
  const authenticatedDriverUnitId = useMemo(
    () => resolveDriverUnitId({ driverUser, drivers: linkedDrivers, previousDriverId: selectedDriverId }),
    [driverUser, linkedDrivers, selectedDriverId],
  );

  const selectedDriver = useMemo(() => {
    const targetDriverId = selectedDriverId ?? authenticatedDriverUnitId;
    return opsState?.drivers.find((driver) => driver.id === targetDriverId) ?? null;
  }, [authenticatedDriverUnitId, opsState, selectedDriverId]);

  const activeRequest = useMemo(() => {
    if (!opsState || !selectedDriver) {
      return null;
    }

    if (selectedDriver.assignment?.requestId) {
      const assignmentRequest =
        opsState.requests.find((request) => request.id === selectedDriver.assignment?.requestId) ?? null;

      if (assignmentRequest && assignmentRequest.status !== 'cancelled' && assignmentRequest.status !== 'completed') {
        return assignmentRequest;
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

  const localMission = useMemo<MissionCoordinates | null>(() => {
    if (!selectedDriver || !activeRequest || !opsState) {
      return null;
    }

    return {
      id: activeRequest.id,
      patientId: activeRequest.id,
      patientAge: activeRequest.age,
      complaint: activeRequest.symptom,
      driverLocation: {
        lat: selectedDriver.location.lat,
        lng: selectedDriver.location.lng,
      },
      pickupLocation: {
        lat: activeRequest.location.lat,
        lng: activeRequest.location.lng,
        address: activeRequest.address,
      },
      hospitalLocation: {
        lat: opsState.hospital.location.lat,
        lng: opsState.hospital.location.lng,
        address: opsState.hospital.address,
        name: opsState.hospital.name,
      },
    };
  }, [activeRequest, opsState, selectedDriver]);

  const apiMission = useMemo<MissionCoordinates | null>(() => {
    if (!apiActiveMission) {
      return null;
    }

    const pickupLat = apiActiveMission.patient_lat;
    const pickupLng = apiActiveMission.patient_lng;
    const hospitalLat = apiActiveMission.hospital_lat;
    const hospitalLng = apiActiveMission.hospital_lng;

    if (!isFiniteCoordinate(pickupLat) || !isFiniteCoordinate(pickupLng)) {
      return null;
    }

    const resolvedHospitalLat = isFiniteCoordinate(hospitalLat) ? hospitalLat : pickupLat;
    const resolvedHospitalLng = isFiniteCoordinate(hospitalLng) ? hospitalLng : pickupLng;

    return {
      id: apiActiveMission.emergency_id,
      patientId: apiActiveMission.emergency_id,
      patientAge: 0,
      complaint: `${apiActiveMission.emergency_type || 'Emergency'} (${apiActiveMission.severity || 'unknown'})`,
      driverLocation: {
        lat: pickupLat - 0.01,
        lng: pickupLng - 0.01,
      },
      pickupLocation: {
        lat: pickupLat,
        lng: pickupLng,
        address: apiActiveMission.patient_address || 'Pickup location',
      },
      hospitalLocation: {
        lat: resolvedHospitalLat,
        lng: resolvedHospitalLng,
        address: apiActiveMission.assigned_hospital_name || 'Assigned hospital',
        name: apiActiveMission.assigned_hospital_name || 'Hospital',
      },
    };
  }, [apiActiveMission]);

  const hasApiOffers = apiPendingOffers.length > 0;

  useEffect(() => {
    // Lock to backend-dispatch mode for this session once API context appears.
    if (apiActiveMission || hasApiOffers) {
      setPreferApiDispatchMode(true);
    }
  }, [apiActiveMission, hasApiOffers]);

  useEffect(() => {
    // Reset mode when driver identity changes or logs out.
    setPreferApiDispatchMode(false);
  }, [driverDispatchId]);

  const apiDispatchHasPriority = preferApiDispatchMode || Boolean(apiActiveMission) || hasApiOffers;
  const mission = apiDispatchHasPriority ? apiMission : (localMission ?? apiMission);
  const usingApiMission = Boolean(apiDispatchHasPriority && apiMission);

  const missionDriverPickupDistance = useMemo(() => {
    if (!mission) {
      return Number.POSITIVE_INFINITY;
    }

    return distanceMeters(
      [mission.driverLocation.lng, mission.driverLocation.lat],
      [mission.pickupLocation.lng, mission.pickupLocation.lat],
    );
  }, [mission]);

  const missionStatus = useMemo<MissionStatusValue | null>(() => {
    if (missionStatusOverride === 'picked_up') {
      return 'picked_up';
    }

    if (apiDispatchHasPriority) {
      return mapBackendStatusToMissionStatus(apiActiveMission?.status);
    }

    if (selectedDriver && activeRequest) {
      if (activeRequest.status === 'completed') {
        return activeRequest.status;
      }

      return selectedDriver.status;
    }

    return null;
  }, [activeRequest, apiActiveMission?.status, apiDispatchHasPriority, missionStatusOverride, selectedDriver]);

  const shouldConfirmPickup =
    missionStatusOverride !== 'picked_up' && missionDriverPickupDistance <= ARRIVAL_METERS;

  const activeLeg = useMemo<ActiveLeg>(() => {
    if (missionStatus === 'completed') {
      return 'arrived';
    }

    // Keep the driver on pickup leg until explicit pickup confirmation.
    if (shouldConfirmPickup) {
      return 'to_pickup';
    }

    if (missionStatus === 'picked_up' || missionStatus === 'with_patient' || missionStatus === 'to_hospital') {
      return 'to_hospital';
    }

    return 'to_pickup';
  }, [missionStatus, shouldConfirmPickup]);

  const missionActive = Boolean(
    missionStatus === 'to_patient' ||
      missionStatus === 'picked_up' ||
      missionStatus === 'with_patient' ||
      missionStatus === 'to_hospital',
  );

  const setMissionStatus = useCallback(
    (nextStatus: 'picked_up') => {
      setMissionStatusOverride(nextStatus);

      if (nextStatus !== 'picked_up' || !opsStorageKey || !selectedDriver?.id || typeof window === 'undefined') {
        return;
      }

      const latestState = loadOpsStateByKey(opsStorageKey);
      if (!latestState) {
        return;
      }

      const nowIso = new Date().toISOString();
      let updated = false;

      const nextDrivers = latestState.drivers.map((driver): typeof driver => {
        if (driver.id !== selectedDriver.id) {
          return driver;
        }

        updated = true;
        return {
          ...driver,
          status: 'to_hospital' as const,
          occupied: true,
          assignment: driver.assignment
            ? {
                ...driver.assignment,
                stage: 'to_hospital' as const,
                stageTicks: 0,
              }
            : driver.assignment,
        };
      });

      if (!updated) {
        return;
      }

      const nextState: HospitalOpsState = {
        ...latestState,
        drivers: nextDrivers,
        lastSimulationAt: nowIso,
      };

      window.localStorage.setItem(opsStorageKey, JSON.stringify(nextState));
      setOpsState(nextState);
    },
    [opsStorageKey, selectedDriver],
  );

  const localPickupCount = useMemo(() => {
    const offers = opsState?.pendingDispatchOffers ?? [];

    if (!selectedDriver?.id) {
      return 0;
    }

    return offers.filter((offer) => offer.offeredDriverId === selectedDriver.id).length;
  }, [opsState?.pendingDispatchOffers, selectedDriver?.id]);

  const pickupCount = Math.max(localPickupCount, apiPendingOffers.length);

  const hasMission = Boolean(mission || apiActiveMission);

  const coordinatesReady = Boolean(
    mission &&
      isFiniteCoordinate(mission.driverLocation.lng) &&
      isFiniteCoordinate(mission.driverLocation.lat) &&
      isFiniteCoordinate(mission.pickupLocation.lng) &&
      isFiniteCoordinate(mission.pickupLocation.lat) &&
      isFiniteCoordinate(mission.hospitalLocation.lng) &&
      isFiniteCoordinate(mission.hospitalLocation.lat),
  );

  const initialDriverPosition = mission
    ? ([mission.driverLocation.lng, mission.driverLocation.lat] as [number, number])
    : null;

  const pingDriverLocation = useCallback(
    ({ lng, lat }: { lng: number; lat: number }) => {
      const timestamp = new Date().toISOString();

      if (localMission?.id) {
        void fetch('/api/driver/update-location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            missionId: localMission.id,
            lat,
            lng,
            timestamp,
          }),
        }).catch(() => {
          // Retry silently on next simulation cycle.
        });
      }

      if (driverDispatchId) {
        void fetch('/api/driver/location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            driver_id: driverDispatchId,
            lat,
            lng,
            speed_kmph: 30,
          }),
        }).catch(() => {
          // Keep polling/simulation running even if one ping fails.
        });
      }

      if (!opsStorageKey || !selectedDriverId || typeof window === 'undefined') {
        return;
      }

      const latestState = loadOpsStateByKey(opsStorageKey);
      if (!latestState) {
        return;
      }

      let changed = false;

      const nextDrivers = latestState.drivers.map((driver) => {
        if (driver.id !== selectedDriverId) {
          return driver;
        }

        changed = true;
        return {
          ...driver,
          location: { lat, lng },
          lastPingAt: timestamp,
          secondsSincePing: 0,
        };
      });

      if (!changed) {
        return;
      }

      const nextState: HospitalOpsState = {
        ...latestState,
        drivers: nextDrivers,
        lastSimulationAt: timestamp,
      };

      window.localStorage.setItem(opsStorageKey, JSON.stringify(nextState));
      setOpsState(nextState);
    },
    [driverDispatchId, localMission?.id, opsStorageKey, selectedDriverId],
  );

  const {
    currentPosition,
    isSimulating,
    currentIndex,
    distanceToNextTurn,
    isMoving,
    hasArrived,
    startSimulation,
    stopSimulation,
    resetSimulation,
    bearingDegrees,
  } = useDriverSimulation({
    initialPosition: initialDriverPosition,
    simulationIntervalMs: FAST_SIMULATION_INTERVAL_MS,
    pingIntervalMs: 5000,
    targetLegDurationSeconds: FAST_SIMULATION_TARGET_LEG_SECONDS,
    onPositionUpdate: ({ lng, lat }) => {
      pingDriverLocation({ lng, lat });
    },
  });

  const effectiveDriverPosition = currentPosition ?? initialDriverPosition;

  const pickupPosition = mission
    ? ([mission.pickupLocation.lng, mission.pickupLocation.lat] as [number, number])
    : null;
  const hospitalPosition = useMemo<[number, number] | null>(() => {
    if (!mission) {
      return null;
    }

    if (missionStatus === 'picked_up') {
      if (nearestHospital) {
        return [nearestHospital.lng, nearestHospital.lat];
      }

      // Fallback so hospital leg starts immediately while nearest lookup resolves.
      return [mission.hospitalLocation.lng, mission.hospitalLocation.lat];
    }

    return [mission.hospitalLocation.lng, mission.hospitalLocation.lat];
  }, [mission, missionStatus, nearestHospital]);

  useEffect(() => {
    const missionId = mission?.id ?? null;

    if (lastMissionIdRef.current === missionId) {
      return;
    }

    lastMissionIdRef.current = missionId;
    setMissionStatusOverride(null);
    setNearestHospital(null);
    setIsResolvingNearestHospital(false);

    if (nearestHospitalLookupRef.current) {
      nearestHospitalLookupRef.current.abort();
      nearestHospitalLookupRef.current = null;
    }

    lastFetchRef.current = null;
    pickupArrivalAnnouncedRef.current = false;
    hospitalArrivalAnnouncedRef.current = false;
    missionCompleteAnnouncedRef.current = false;
  }, [mission?.id]);

  useEffect(() => {
    if (!mission) {
      announced200Ref.current.clear();
      announced50Ref.current.clear();
      straightAnnouncedRef.current.clear();
      pickupArrivalAnnouncedRef.current = false;
      hospitalArrivalAnnouncedRef.current = false;
      missionCompleteAnnouncedRef.current = false;
    }
  }, [mission]);

  useEffect(() => {
    if (!mission || !coordinatesReady || !effectiveDriverPosition || !pickupPosition || !hospitalPosition) {
      return;
    }

    if (activeLeg === 'arrived' || !MAPBOX_TOKEN) {
      return;
    }

    const pickupDistanceFromDriver = distanceMeters(effectiveDriverPosition, pickupPosition);
    const hospitalDistanceFromDriver = distanceMeters(effectiveDriverPosition, hospitalPosition);

    if (activeLeg === 'to_pickup' && pickupDistanceFromDriver <= ARRIVAL_METERS) {
      return;
    }

    if (activeLeg === 'to_hospital' && hospitalDistanceFromDriver <= ARRIVAL_METERS) {
      return;
    }

    const currentLeg = activeLeg;
    const lastFetch = lastFetchRef.current;
    const movedSignificantly =
      lastFetch !== null && distanceMeters(lastFetch.origin, effectiveDriverPosition) > REROUTE_METERS;

    const shouldFetch =
      !lastFetch ||
      lastFetch.leg !== currentLeg ||
      lastFetch.missionId !== mission.id ||
      (!isSimulating && movedSignificantly) ||
      retryNonce > 0;

    if (!shouldFetch) {
      return;
    }

    const controller = new AbortController();
    let disposed = false;

    setIsLoadingRoute(true);
    setRouteError(null);

    void fetchDirectionsRoute({
      token: MAPBOX_TOKEN,
      origin: effectiveDriverPosition,
      pickup: pickupPosition,
      destination: hospitalPosition,
      activeLeg: currentLeg,
      signal: controller.signal,
    })
      .then((nextRoute) => {
        if (disposed) {
          return;
        }

        setRouteData(nextRoute);
        setNavStepIndex(0);
        announced200Ref.current.clear();
        announced50Ref.current.clear();
        straightAnnouncedRef.current.clear();
        setRetryNonce(0);

        lastFetchRef.current = {
          origin: effectiveDriverPosition,
          leg: currentLeg,
          missionId: mission.id,
        };
      })
      .catch(() => {
        if (disposed) {
          return;
        }

        setRouteError('Route unavailable - retrying in 3s');
        if (retryTimerRef.current !== null) {
          window.clearTimeout(retryTimerRef.current);
        }

        retryTimerRef.current = window.setTimeout(() => {
          setRetryNonce((value) => value + 1);
        }, 3000);
      })
      .finally(() => {
        if (!disposed) {
          setIsLoadingRoute(false);
        }
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [
    activeLeg,
    coordinatesReady,
    effectiveDriverPosition,
    hospitalPosition,
    isSimulating,
    mission,
    pickupPosition,
    retryNonce,
  ]);

  useEffect(() => {
    if (!routeData || activeLeg === 'arrived') {
      return;
    }

    if (routeData.leg !== activeLeg) {
      return;
    }

    startSimulation(routeData.coordinates);
  }, [activeLeg, routeData, startSimulation]);

  useEffect(() => {
    if (activeLeg === 'arrived') {
      stopSimulation();
    }
  }, [activeLeg, stopSimulation]);

  const fitRouteOverview = useCallback(() => {
    if (!mapRef.current || !routeData || routeData.coordinates.length === 0) {
      return;
    }

    const [firstLng, firstLat] = routeData.coordinates[0];
    let minLng = firstLng;
    let maxLng = firstLng;
    let minLat = firstLat;
    let maxLat = firstLat;

    for (const [lng, lat] of routeData.coordinates) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }

    mapRef.current.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 72, duration: 900 },
    );
  }, [routeData]);

  useEffect(() => {
    if (!routeData) {
      return;
    }

    fitRouteOverview();

    if (activeLeg === 'to_pickup') {
      speak('Route calculated. Navigating to patient pickup.', true);
      return;
    }

    if (activeLeg === 'to_hospital' && missionStatus === 'picked_up') {
      speak('Navigating to nearest hospital.', true);
    }
  }, [activeLeg, fitRouteOverview, missionStatus, routeData, speak]);

  useEffect(() => {
    if (!routeData || !effectiveDriverPosition || activeLeg === 'arrived') {
      return;
    }

    mapRef.current?.easeTo({
      center: effectiveDriverPosition,
      zoom: 15,
      pitch: 45,
      bearing: bearingDegrees,
      duration: 1000,
    });
  }, [activeLeg, bearingDegrees, effectiveDriverPosition, routeData]);

  const steps = routeData?.steps ?? [];
  const boundedStepIndex = Math.min(navStepIndex, Math.max(0, steps.length - 1));
  const currentStep = steps[boundedStepIndex] ?? null;
  const nextStep = steps[boundedStepIndex + 1] ?? null;

  const maneuverDistanceMeters = useMemo(() => {
    if (!effectiveDriverPosition || !currentStep?.maneuver.location) {
      return distanceToNextTurn;
    }

    return distanceMeters(effectiveDriverPosition, currentStep.maneuver.location);
  }, [currentStep?.maneuver.location, distanceToNextTurn, effectiveDriverPosition]);

  useEffect(() => {
    if (!currentStep || !effectiveDriverPosition || !currentStep.maneuver.location) {
      return;
    }

    if (maneuverDistanceMeters <= TURN_ANNOUNCE_50_METERS && boundedStepIndex < steps.length - 1) {
      setNavStepIndex((previous) => Math.min(previous + 1, steps.length - 1));
    }
  }, [boundedStepIndex, currentStep, effectiveDriverPosition, maneuverDistanceMeters, steps.length]);

  useEffect(() => {
    if (!currentStep || activeLeg === 'arrived') {
      return;
    }

    const stepKey = boundedStepIndex;
    const voiceText =
      currentStep.voiceInstructions[0]?.announcement ||
      currentStep.bannerInstructions[0]?.primary?.text ||
      currentStep.instruction;

    if (
      maneuverDistanceMeters <= TURN_ANNOUNCE_200_METERS &&
      maneuverDistanceMeters > TURN_ANNOUNCE_50_METERS &&
      !announced200Ref.current.has(stepKey)
    ) {
      speak(`In 200 meters, ${voiceText}`, true);
      announced200Ref.current.add(stepKey);
    }

    if (maneuverDistanceMeters <= TURN_ANNOUNCE_50_METERS && !announced50Ref.current.has(stepKey)) {
      speak(voiceText, true);
      announced50Ref.current.add(stepKey);
    }
  }, [activeLeg, boundedStepIndex, currentStep, maneuverDistanceMeters, speak]);

  useEffect(() => {
    if (!currentStep) {
      return;
    }

    if (straightAnnouncedRef.current.has(boundedStepIndex)) {
      return;
    }

    const isStraightManeuver =
      currentStep.maneuver.type === 'continue' ||
      currentStep.maneuver.modifier === 'straight';

    if (isStraightManeuver && currentStep.distance > 500) {
      speak(`Continue straight for ${Math.round(currentStep.distance)} meters`);
      straightAnnouncedRef.current.add(boundedStepIndex);
    }
  }, [boundedStepIndex, currentStep, speak]);

  useEffect(() => {
    if (!mission) {
      return;
    }

    if (activeLeg === 'arrived' && !missionCompleteAnnouncedRef.current) {
      speak('Arrived at hospital. Mission complete.', true);
      missionCompleteAnnouncedRef.current = true;
    }
  }, [activeLeg, mission, speak]);

  const pickupDistance = useMemo(() => {
    if (!effectiveDriverPosition || !pickupPosition) {
      return Number.POSITIVE_INFINITY;
    }

    return distanceMeters(effectiveDriverPosition, pickupPosition);
  }, [effectiveDriverPosition, pickupPosition]);

  const hospitalDistance = useMemo(() => {
    if (!effectiveDriverPosition || !hospitalPosition) {
      return Number.POSITIVE_INFINITY;
    }

    return distanceMeters(effectiveDriverPosition, hospitalPosition);
  }, [effectiveDriverPosition, hospitalPosition]);

  const pickupArrivalDetected = useMemo(() => {
    if (pickupDistance <= ARRIVAL_METERS) {
      return true;
    }

    if (routeData?.leg !== 'to_pickup' || !effectiveDriverPosition) {
      return false;
    }

    const routeEnd = routeData.coordinates[routeData.coordinates.length - 1];
    const nearRouteEnd = routeEnd ? distanceMeters(effectiveDriverPosition, routeEnd) <= ARRIVAL_METERS : false;
    const arriveManeuverReached =
      currentStep?.maneuver.type === 'arrive' && maneuverDistanceMeters <= ARRIVAL_METERS;

    return nearRouteEnd || arriveManeuverReached || hasArrived;
  }, [
    currentStep?.maneuver.type,
    effectiveDriverPosition,
    hasArrived,
    maneuverDistanceMeters,
    pickupDistance,
    routeData,
  ]);

  const showMarkAsPickedButton =
    activeLeg === 'to_pickup' && missionStatus !== 'completed' && missionStatusOverride !== 'picked_up' && pickupArrivalDetected;

  const reachedHospital = activeLeg === 'to_hospital' && (hospitalDistance <= ARRIVAL_METERS || hasArrived);

  const showMarkAsCompletedButton =
    activeLeg === 'to_hospital' && missionStatus !== 'completed' && reachedHospital;

  useEffect(() => {
    if (!showMarkAsPickedButton || pickupArrivalAnnouncedRef.current) {
      return;
    }

    pickupArrivalAnnouncedRef.current = true;
    stopSimulation();
    speak('You have arrived at pickup location. Please confirm pickup.', true);
  }, [showMarkAsPickedButton, speak, stopSimulation]);

  /** Fallback hospital lookup via Mapbox Geocoding when backend has no hospital data */
  const _fallbackToMapboxHospitalLookup = useCallback(() => {
    if (!effectiveDriverPosition || !MAPBOX_TOKEN) {
      setIsResolvingNearestHospital(false);
      return;
    }

    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (nearestHospitalLookupRef.current) {
      nearestHospitalLookupRef.current.abort();
    }

    const controller = new AbortController();
    nearestHospitalLookupRef.current = controller;

    void fetchNearestHospital({
      token: MAPBOX_TOKEN,
      proximity: effectiveDriverPosition,
      signal: controller.signal,
    })
      .then((hospital) => {
        if (controller.signal.aborted) {
          return;
        }

        setNearestHospital(hospital);
        lastFetchRef.current = null;
        setRetryNonce((value) => value + 1);
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return;
        }

        setRouteError('Nearest hospital lookup unavailable. Continuing to assigned hospital route.');
      })
      .finally(() => {
        if (nearestHospitalLookupRef.current === controller) {
          nearestHospitalLookupRef.current = null;
        }

        setIsResolvingNearestHospital(false);
      });
  }, [effectiveDriverPosition]);

  const handleMarkAsPicked = useCallback(() => {
    if (!mission || !effectiveDriverPosition || isResolvingNearestHospital) {
      return;
    }

    if (!MAPBOX_TOKEN) {
      setRouteError('Mapbox token missing. Cannot find nearest hospital.');
      return;
    }

    setMissionStatus('picked_up');
    // Stop simulation instead of reset, to prevent snapping back to start
    stopSimulation();
    setRouteData(null);
    setNavStepIndex(0);
    announced200Ref.current.clear();
    announced50Ref.current.clear();
    straightAnnouncedRef.current.clear();
    lastFetchRef.current = null;
    setRetryNonce((value) => value + 1);
    setRouteError(null);
    setIsResolvingNearestHospital(true);
    speak('Patient on board. Finding nearest hospital with available beds.', true);

    if (usingApiMission && apiActiveMission?.emergency_id) {
      const lat = effectiveDriverPosition[1];
      const lng = effectiveDriverPosition[0];

      void (async () => {
        // Step through required transitions to reach PATIENT_PICKED
        if (apiActiveMission.status === 'DRIVER_ASSIGNED') {
          const enRoute = await updateStatus(
            apiActiveMission.emergency_id,
            'EN_ROUTE_PATIENT',
            lat,
            lng,
          );

          if (!enRoute.success) {
            setMissionStatusOverride(null);
            setRouteError(enRoute.message || 'Unable to start patient route.');
            setIsResolvingNearestHospital(false);
            return;
          }
        }

        // Transition to PATIENT_PICKED — backend auto-finds nearest hospital
        const picked = await updateStatus(
          apiActiveMission.emergency_id,
          'PATIENT_PICKED',
          lat,
          lng,
        );

        if (!picked.success) {
          setMissionStatusOverride(null);
          setRouteError(picked.message || 'Unable to mark patient as picked.');
          setIsResolvingNearestHospital(false);
          return;
        }

        // Use backend-recommended hospital if available
        const recHospital = picked.recommended_hospital;
        if (recHospital && recHospital.lat != null && recHospital.lng != null) {
          const backendHospital: NearestHospital = {
            name: recHospital.name,
            address: recHospital.address || recHospital.name,
            lng: recHospital.lng,
            lat: recHospital.lat,
          };
          setNearestHospital(backendHospital);
          lastFetchRef.current = null;
          setRetryNonce((value) => value + 1);
          setIsResolvingNearestHospital(false);

          const bedsInfo = recHospital.available_beds != null
            ? ` with ${recHospital.available_beds} beds available`
            : '';
          speak(
            `Hospital assigned: ${recHospital.name}${bedsInfo}. Calculating route now.`,
            true,
          );
          return;
        }

        // Fallback: use Mapbox geocoding if backend didn't return hospital coords
        _fallbackToMapboxHospitalLookup();
      })();

      return;
    }

    // Non-API mission: fallback to Mapbox geocoding
    _fallbackToMapboxHospitalLookup();

  }, [
    _fallbackToMapboxHospitalLookup,
    apiActiveMission?.emergency_id,
    apiActiveMission?.status,
    effectiveDriverPosition,
    isResolvingNearestHospital,
    resetSimulation,
    setMissionStatus,
    speak,
    stopSimulation,
    updateStatus,
    usingApiMission,
  ]);

  const handleMarkAsCompleted = useCallback(() => {
    if (isCompletingMission) {
      return;
    }

    setIsCompletingMission(true);

    if (usingApiMission && apiActiveMission?.emergency_id) {
      const lat = effectiveDriverPosition ? effectiveDriverPosition[1] : undefined;
      const lng = effectiveDriverPosition ? effectiveDriverPosition[0] : undefined;

      stopSimulation();
      setRouteError(null);
      void (async () => {
        const transitionPlanByStatus: Record<string, string[]> = {
          DRIVER_ASSIGNED: ['EN_ROUTE_PATIENT', 'PATIENT_PICKED', 'EN_ROUTE_HOSPITAL', 'COMPLETED'],
          EN_ROUTE_PATIENT: ['PATIENT_PICKED', 'EN_ROUTE_HOSPITAL', 'COMPLETED'],
          PATIENT_PICKED: ['EN_ROUTE_HOSPITAL', 'COMPLETED'],
          HOSPITAL_ASSIGNED: ['EN_ROUTE_HOSPITAL', 'COMPLETED'],
          EN_ROUTE_HOSPITAL: ['COMPLETED'],
          COMPLETED: [],
        };

        const transitionPlan = transitionPlanByStatus[apiActiveMission.status] ?? ['COMPLETED'];

        for (const nextStatus of transitionPlan) {
          const stepResult = await updateStatus(apiActiveMission.emergency_id, nextStatus, lat, lng);
          if (!stepResult.success) {
            setRouteError(stepResult.message || `Unable to transition mission to ${nextStatus}.`);
            setIsCompletingMission(false);
            return;
          }
        }

        setMissionStatusOverride(null);
        setNearestHospital(null);
        setRouteData(null);
        setNavStepIndex(0);
        lastFetchRef.current = null;
        speak('Mission marked as completed. You are now available for new assignments.', true);
        
        setCompletionSummary({ id: apiActiveMission.emergency_id });
        setTimeout(() => {
          setCompletionSummary(null);
          setIsCompletingMission(false);
        }, 5000);
      })();

      return;
    }

    if (!mission?.id || !opsStorageKey || !selectedDriverId || typeof window === 'undefined') {
      setIsCompletingMission(false);
      return;
    }

    const latestState = loadOpsStateByKey(opsStorageKey);
    if (!latestState) {
      setIsCompletingMission(false);
      return;
    }

    const timestamp = new Date().toISOString();
    let requestUpdated = false;
    let driverUpdated = false;

    const nextRequests = latestState.requests.map((request) => {
      if (request.id !== mission.id) {
        return request;
      }

      requestUpdated = true;
      return {
        ...request,
        status: 'completed' as const,
        closedAt: timestamp,
        notes: `${request.notes ? `${request.notes} | ` : ''}Mission completed by driver.`,
      };
    });

    const nextDrivers = latestState.drivers.map((driver) => {
      if (driver.id !== selectedDriverId) {
        return driver;
      }

      driverUpdated = true;
      return {
        ...driver,
        status: 'available' as const,
        occupied: false,
        assignment: undefined,
        etaMinutes: undefined,
        location: effectiveDriverPosition
          ? { lat: effectiveDriverPosition[1], lng: effectiveDriverPosition[0] }
          : driver.location,
        lastPingAt: timestamp,
        secondsSincePing: 0,
      };
    });

    if (!requestUpdated || !driverUpdated) {
      setIsCompletingMission(false);
      return;
    }

    const nextState: HospitalOpsState = {
      ...latestState,
      requests: nextRequests,
      drivers: nextDrivers,
      pendingDispatchOffers: Array.isArray(latestState.pendingDispatchOffers)
        ? latestState.pendingDispatchOffers.filter((offer) => offer.requestId !== mission.id)
        : [],
      lastSimulationAt: timestamp,
    };

    stopSimulation();
    setMissionStatusOverride(null);
    setNearestHospital(null);
    setRouteData(null);
    setNavStepIndex(0);
    setRouteError(null);
    lastFetchRef.current = null;

    window.localStorage.setItem(opsStorageKey, JSON.stringify(nextState));
    setOpsState(nextState);
    speak('Mission marked as completed. You are now available for new assignments.', true);
    setIsCompletingMission(false);
  }, [
    apiActiveMission?.emergency_id,
    apiActiveMission?.status,
    effectiveDriverPosition,
    isCompletingMission,
    mission?.id,
    opsStorageKey,
    selectedDriverId,
    speak,
    stopSimulation,
    updateStatus,
    usingApiMission,
  ]);

  useEffect(() => {
    if (!mission) {
      return;
    }

    if (activeLeg === 'to_hospital' && hospitalDistance <= ARRIVAL_METERS && !hospitalArrivalAnnouncedRef.current) {
      speak('Arrived at hospital. Please mark as completed.', true);
      hospitalArrivalAnnouncedRef.current = true;
      stopSimulation();
    }
  }, [activeLeg, hospitalDistance, mission, speak, stopSimulation]);

  const routeGeoJson = useMemo(() => {
    if (!routeData || routeData.coordinates.length < 2) {
      return null;
    }

    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: routeData.coordinates,
      },
    };
  }, [routeData]);

  const mapInitialView = useMemo(() => {
    if (effectiveDriverPosition) {
      return {
        longitude: effectiveDriverPosition[0],
        latitude: effectiveDriverPosition[1],
        zoom: 13,
        pitch: 45,
        bearing: 0,
      };
    }

    if (pickupPosition) {
      return {
        longitude: pickupPosition[0],
        latitude: pickupPosition[1],
        zoom: 12,
        pitch: 30,
        bearing: 0,
      };
    }

    return {
      longitude: 72.8777,
      latitude: 19.076,
      zoom: 11,
      pitch: 0,
      bearing: 0,
    };
  }, [effectiveDriverPosition, pickupPosition]);

  const currentInstruction = currentStep?.instruction ?? 'Follow the highlighted route';
  const nextInstruction = nextStep?.instruction ?? 'Continue on current road';
  const maneuverType = currentStep?.maneuver.type ?? 'continue';
  const maneuverModifier = currentStep?.maneuver.modifier ?? 'straight';
  const destinationName =
    activeLeg === 'to_hospital'
      ? nearestHospital?.name ?? mission?.hospitalLocation.name ?? 'Hospital'
      : mission?.pickupLocation.address ?? 'Pickup location';

  const simulationBannerText = routeData
    ? isSimulating
      ? 'Simulation running - movement every 1s, ping every 5s'
      : 'Simulation paused'
    : null;

  const arrivalOverlayVisible = activeLeg === 'arrived' || (activeLeg === 'to_hospital' && (hospitalDistance <= ARRIVAL_METERS || hasArrived));

  const centerOnDriver = useCallback(() => {
    if (!mapRef.current || !effectiveDriverPosition) {
      return;
    }

    mapRef.current.easeTo({
      center: effectiveDriverPosition,
      zoom: 15,
      pitch: 45,
      bearing: bearingDegrees,
      duration: 800,
    });
  }, [bearingDegrees, effectiveDriverPosition]);

  const handleSosVoice = useCallback(() => {
    speak('SOS activated. Emergency services alerted.', true);
  }, [speak]);

  const showDispatchOffers = apiPendingOffers.length > 0 && !apiActiveMission;

  if (!isDriverAuthenticated || !driverUser) {
    if (typeof window !== 'undefined') {
      window.location.hash = '/auth';
    }
    return null;
  }

  if (!hasMission) {
    return (
      <DriverLayout missionActive={false} pickupCount={pickupCount} onLogout={logoutDriverUser}>
        <main style={{ padding: '20px', display: 'grid', gap: '12px' }}>
          {showDispatchOffers ? (
            <section
              style={{
                border: '1px solid #fecaca',
                background: '#fff1f2',
                borderRadius: '14px',
                padding: '16px',
                display: 'grid',
                gap: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '999px',
                    background: '#fee2e2',
                    color: '#b91c1c',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  <PhoneCall size={18} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', color: '#7f1d1d' }}>Incoming dispatch offers</h3>
                  <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#991b1b' }}>
                    Review and accept or reject assignments.
                  </p>
                </div>
              </div>

              {apiPendingOffers.map((offer) => (
                <article
                  key={offer.offer_id}
                  style={{
                    border: '1px solid #fecaca',
                    background: '#ffffff',
                    borderRadius: '12px',
                    padding: '12px',
                    display: 'grid',
                    gap: '4px',
                  }}
                >
                  <p style={{ margin: 0, fontWeight: 700, color: '#7f1d1d' }}>
                    {offer.emergency_type.toUpperCase().replace('_', ' ')} - {offer.severity.toUpperCase()}
                  </p>
                  <p style={{ margin: 0, color: '#7f1d1d', fontSize: '13px' }}>{offer.patient_address}</p>
                  <p style={{ margin: 0, color: '#7f1d1d', fontSize: '13px' }}>{offer.patient_phone}</p>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                    <button
                      type="button"
                      onClick={() => {
                        void acceptOffer(offer.emergency_id, offer.offer_id);
                      }}
                      style={{
                        border: 'none',
                        borderRadius: '10px',
                        background: '#16a34a',
                        color: '#ffffff',
                        padding: '8px 12px',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void rejectOffer(offer.emergency_id, offer.offer_id);
                      }}
                      style={{
                        border: 'none',
                        borderRadius: '10px',
                        background: '#334155',
                        color: '#ffffff',
                        padding: '8px 12px',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {emptyState(showDispatchOffers ? 'Pending offers available.' : 'No active mission assigned')}
        </main>
      </DriverLayout>
    );
  }

  if (!coordinatesReady) {
    return (
      <DriverLayout missionActive={missionActive} pickupCount={pickupCount} onLogout={logoutDriverUser}>
        <main style={{ padding: '20px' }}>{emptyState('Waiting for dispatch coordinates...')}</main>
      </DriverLayout>
    );
  }

  if (!MAPBOX_TOKEN) {
    return (
      <DriverLayout missionActive={missionActive} pickupCount={pickupCount} onLogout={logoutDriverUser}>
        <main style={{ padding: '20px' }}>
          {emptyState('Mapbox token missing. Set VITE_MAPBOX_ACCESS_TOKEN to enable live mission navigation.')}
        </main>
      </DriverLayout>
    );
  }

  if (completionSummary) {
    return (
      <DriverLayout missionActive={false} pickupCount={0} onLogout={logoutDriverUser}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#f8fafc' }}>
          <div style={{ background: 'white', padding: '3rem', borderRadius: '16px', boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1)', textAlign: 'center' }}>
            <div style={{ background: '#16a34a', color: '#15803d', width: '80px', height: '80px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem auto' }}>
              <span style={{color: 'white', fontSize: 40}}>✓</span>
            </div>
            <h2 style={{ margin: '0 0 0.5rem 0', color: '#0f172a', fontSize: '1.5rem' }}>Mission Completed</h2>
            <p style={{ margin: '0 0 1.5rem 0', color: '#475569' }}>Patient safely delivered for #{completionSummary.id}</p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', color: '#64748b', fontSize: '0.9rem' }}>
              <div style={{ background: '#f1f5f9', padding: '0.75rem 1rem', borderRadius: '8px' }}>
                <strong>ETA Target Met</strong>
              </div>
              <div style={{ background: '#f1f5f9', padding: '0.75rem 1rem', borderRadius: '8px' }}>
                <strong>Golden Hour Maintained</strong>
              </div>
            </div>
          </div>
        </div>
      </DriverLayout>
    );
  }

  return (
    <DriverLayout missionActive={missionActive} pickupCount={pickupCount} onLogout={logoutDriverUser}>
      <main style={{ padding: '16px', display: 'grid', gap: '12px' }}>
        <style>
          {`
            @keyframes live-mission-pulse {
              0% { transform: scale(1); opacity: 0.92; }
              50% { transform: scale(1.2); opacity: 0.45; }
              100% { transform: scale(1); opacity: 0.92; }
            }
          `}
        </style>

        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            borderRadius: '14px',
            border: '1px solid #e2e8f0',
            background: '#ffffff',
            padding: '14px 16px',
          }}
        >
          <div>
            <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
              Live Mission
            </p>
            <h1 style={{ margin: '4px 0 0', fontSize: '22px', color: '#0f172a' }}>
              {mission?.id ?? 'Mission'}
            </h1>
            <p style={{ margin: '4px 0 0', color: '#475569', fontSize: '14px' }}>
              Status: {missionStatus ?? 'waiting'} - Source: {usingApiMission ? 'backend dispatch' : opsStorageKey ? 'linked storage' : 'waiting'}
            </p>
          </div>

          <div style={{ display: 'grid', gap: '6px', justifyItems: 'end' }}>
            <span
              style={{
                borderRadius: '999px',
                border: '1px solid #fecaca',
                background: '#fff1f2',
                color: '#9f1239',
                fontSize: '12px',
                fontWeight: 700,
                padding: '6px 10px',
              }}
            >
              Demo Mode (Fast Simulation Enabled)
            </span>

            {simulationBannerText ? (
              <span
                style={{
                  borderRadius: '999px',
                  border: '1px solid #d1d5db',
                  background: '#f8fafc',
                  color: '#334155',
                  fontSize: '12px',
                  fontWeight: 700,
                  padding: '6px 10px',
                }}
              >
                {simulationBannerText}
              </span>
            ) : null}
          </div>
        </header>

        {routeError ? (
          <section
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              borderRadius: '12px',
              border: '1px solid #fecaca',
              background: '#fff1f2',
              color: '#991b1b',
              fontSize: '14px',
              padding: '10px 12px',
            }}
          >
            <AlertTriangle size={16} />
            <span>{routeError}</span>
          </section>
        ) : null}

        <section
          style={{
            position: 'relative',
            minHeight: '72vh',
            borderRadius: '14px',
            overflow: 'hidden',
            border: '1px solid #e2e8f0',
            background: '#e2e8f0',
          }}
        >
          <Map
            ref={mapRef}
            initialViewState={mapInitialView}
            mapboxAccessToken={MAPBOX_TOKEN}
            mapStyle="mapbox://styles/mapbox/navigation-day-v1"
            attributionControl={false}
            style={{ width: '100%', height: '100%' }}
          >
            <NavigationControl position="top-right" />

            {routeGeoJson ? (
              <Source
                key={routeData?.loadedAt ?? 'initial'}
                id="live-mission-route-source"
                type="geojson"
                data={routeGeoJson}
              >
                <Layer {...routeLineLayer} />
              </Source>
            ) : null}

            {effectiveDriverPosition ? (
              <Marker longitude={effectiveDriverPosition[0]} latitude={effectiveDriverPosition[1]} anchor="center">
                <div
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '999px',
                    border: '2px solid #ffffff',
                    background: '#ef4444',
                    position: 'relative',
                    transform: `rotate(${bearingDegrees}deg)`,
                    display: 'grid',
                    placeItems: 'center',
                    boxShadow: '0 8px 18px rgba(15, 23, 42, 0.28)',
                  }}
                  title="Driver location"
                >
                  <span
                    style={{
                      width: '9px',
                      height: '9px',
                      borderRadius: '999px',
                      background: '#ffffff',
                      position: 'absolute',
                      animation: 'live-mission-pulse 1.4s ease-in-out infinite',
                    }}
                  />
                </div>
              </Marker>
            ) : null}

            {activeLeg === 'to_pickup' && pickupPosition ? (
              <Marker longitude={pickupPosition[0]} latitude={pickupPosition[1]} anchor="bottom">
                <div
                  style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '999px',
                    border: '2px solid #fff',
                    background: '#f97316',
                    boxShadow: '0 8px 16px rgba(15, 23, 42, 0.22)',
                  }}
                  title={`${mission?.patientId ?? 'Patient'} - ${mission?.patientAge ?? 0}Y - ${mission?.complaint ?? ''}`}
                />
              </Marker>
            ) : null}

            {hospitalPosition ? (
              <Marker longitude={hospitalPosition[0]} latitude={hospitalPosition[1]} anchor="bottom">
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '999px',
                    border: '2px solid #fff',
                    background: '#16a34a',
                    color: '#ffffff',
                    fontWeight: 800,
                    display: 'grid',
                    placeItems: 'center',
                    boxShadow: '0 8px 16px rgba(15, 23, 42, 0.22)',
                  }}
                  title={`${nearestHospital?.name ?? mission?.hospitalLocation.name ?? 'Hospital'} - ${nearestHospital?.address ?? mission?.hospitalLocation.address ?? ''}`}
                >
                  +
                </div>
              </Marker>
            ) : null}
          </Map>

          <NavigationPanel
            currentInstruction={currentInstruction}
            nextInstruction={nextInstruction}
            distanceToTurn={maneuverDistanceMeters}
            maneuverType={maneuverType}
            maneuverModifier={maneuverModifier}
            eta={routeData?.etaSeconds ?? 0}
            totalDistanceRemaining={routeData?.remainingDistanceMeters ?? 0}
            destinationName={destinationName}
            isSimulating={isSimulating}
          />

          <div
            style={{
              position: 'absolute',
              right: '14px',
              bottom: '14px',
              zIndex: 45,
              display: 'grid',
              gap: '8px',
            }}
          >
            {supportsSpeech ? (
              <button
                type="button"
                onClick={() => setVoiceEnabled((enabled) => !enabled)}
                style={{
                  border: 'none',
                  width: '42px',
                  height: '42px',
                  borderRadius: '12px',
                  background: '#111827',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'grid',
                  placeItems: 'center',
                }}
                title={voiceEnabled ? 'Mute voice guidance' : 'Enable voice guidance'}
              >
                {voiceEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </button>
            ) : null}

            <button
              type="button"
              onClick={centerOnDriver}
              style={{
                border: 'none',
                width: '42px',
                height: '42px',
                borderRadius: '12px',
                background: '#111827',
                color: '#fff',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
              title="Center on driver"
            >
              <Crosshair size={18} />
            </button>

            <button
              type="button"
              onClick={fitRouteOverview}
              style={{
                border: 'none',
                width: '42px',
                height: '42px',
                borderRadius: '12px',
                background: '#111827',
                color: '#fff',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
              title="Overview route"
            >
              <Maximize2 size={18} />
            </button>
          </div>

          {routeData && activeLeg !== 'arrived' ? (
            <div
              style={{
                position: 'absolute',
                left: '14px',
                bottom: '14px',
                zIndex: 45,
                borderRadius: '12px',
                border: '1px solid #cbd5e1',
                background: 'rgba(255, 255, 255, 0.95)',
                display: 'grid',
                gap: '8px',
                padding: '10px 12px',
              }}
            >
              <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: '#334155' }}>
                Simulation mode - real route playback
              </p>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => startSimulation(routeData.coordinates)}
                  style={{
                    border: 'none',
                    borderRadius: '8px',
                    background: '#111827',
                    color: '#fff',
                    padding: '7px 10px',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                  }}
                >
                  <Play size={13} /> Start
                </button>
                <button
                  type="button"
                  onClick={stopSimulation}
                  style={{
                    border: 'none',
                    borderRadius: '8px',
                    background: '#334155',
                    color: '#fff',
                    padding: '7px 10px',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                  }}
                >
                  <Pause size={13} /> Pause
                </button>
                <button
                  type="button"
                  onClick={resetSimulation}
                  style={{
                    border: 'none',
                    borderRadius: '8px',
                    background: '#e2e8f0',
                    color: '#0f172a',
                    padding: '7px 10px',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                  }}
                >
                  <RotateCcw size={13} /> Reset
                </button>
              </div>
            </div>
          ) : null}

          {showMarkAsPickedButton ? (
            <button
              type="button"
              className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-xl shadow-lg z-50"
              onClick={handleMarkAsPicked}
              disabled={isResolvingNearestHospital}
              style={{
                position: 'absolute',
                left: '50%',
                bottom: '24px',
                transform: 'translateX(-50%)',
                zIndex: 50,
                background: '#dc2626',
                color: '#ffffff',
                borderRadius: '12px',
                padding: '12px 24px',
                fontWeight: 700,
                boxShadow: '0 12px 28px rgba(15, 23, 42, 0.3)',
                border: 'none',
                cursor: isResolvingNearestHospital ? 'wait' : 'pointer',
                opacity: isResolvingNearestHospital ? 0.8 : 1,
              }}
            >
              {isResolvingNearestHospital ? 'Finding nearest hospital...' : 'Mark as Picked'}
            </button>
          ) : null}

          {showMarkAsCompletedButton ? (
            <button
              type="button"
              onClick={handleMarkAsCompleted}
              disabled={isCompletingMission}
              style={{
                position: 'absolute',
                left: '50%',
                bottom: '24px',
                transform: 'translateX(-50%)',
                zIndex: 50,
                background: '#16a34a',
                color: '#ffffff',
                borderRadius: '12px',
                padding: '12px 24px',
                fontWeight: 700,
                boxShadow: '0 12px 28px rgba(15, 23, 42, 0.3)',
                border: 'none',
                cursor: isCompletingMission ? 'wait' : 'pointer',
                opacity: isCompletingMission ? 0.8 : 1,
              }}
            >
              {isCompletingMission ? 'Completing mission...' : 'Mark as Completed'}
            </button>
          ) : null}

          <button
            type="button"
            onClick={handleSosVoice}
            style={{
              position: 'absolute',
              left: '14px',
              top: '14px',
              zIndex: 45,
              border: 'none',
              borderRadius: '10px',
              background: '#dc2626',
              color: '#fff',
              padding: '8px 12px',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: '12px',
            }}
          >
            SOS
          </button>

          {arrivalOverlayVisible ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                zIndex: 48,
                pointerEvents: 'none',
              }}
            >
              <div
                style={{
                  borderRadius: '14px',
                  background: 'rgba(15, 23, 42, 0.86)',
                  color: '#fff',
                  padding: '14px 18px',
                  textAlign: 'center',
                  maxWidth: '420px',
                }}
              >
                <h3 style={{ margin: 0, fontSize: '18px' }}>Arrived at destination</h3>
                <p style={{ margin: '6px 0 0', fontSize: '14px', color: '#e2e8f0' }}>
                  {destinationName}
                </p>
              </div>
            </div>
          ) : null}

          {isLoadingRoute ? (
            <div
              style={{
                position: 'absolute',
                left: '50%',
                bottom: '20px',
                transform: 'translateX(-50%)',
                zIndex: 46,
                borderRadius: '999px',
                padding: '6px 12px',
                background: 'rgba(15, 23, 42, 0.78)',
                color: '#f8fafc',
                fontSize: '12px',
                fontWeight: 700,
              }}
            >
              Updating route...
            </div>
          ) : null}
        </section>

        <section
          style={{
            borderRadius: '14px',
            border: '1px solid #e2e8f0',
            background: '#ffffff',
            padding: '12px 14px',
            color: '#334155',
            fontSize: '13px',
            display: 'grid',
            gap: '4px',
          }}
        >
          <p style={{ margin: 0 }}>
            Driver: {selectedDriver?.callSign ?? driverDispatchId ?? 'driver'} - Mission status: {missionStatus ?? 'waiting'}
          </p>
          <p style={{ margin: 0 }}>
            Destination: {destinationName} - ETA: {Math.max(0, Math.round((routeData?.etaSeconds ?? 0) / 60))} min -
            Remaining: {((routeData?.remainingDistanceMeters ?? 0) / 1000).toFixed(1)} km
          </p>
          <p style={{ margin: 0 }}>
            Navigation index: {Math.max(currentIndex, boundedStepIndex)} - Distance to next turn:{' '}
            {Math.round(maneuverDistanceMeters)} m - {isMoving ? 'Moving' : 'Idle'}
          </p>
        </section>
      </main>
    </DriverLayout>
  );
}
