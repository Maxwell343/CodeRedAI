import {
  DriverUnit,
  HospitalLocationRef,
  HospitalOpsState,
  HospitalUnit,
  OpsEvent,
  PatientRequest,
} from '../types/hospitalOps.types';

const now = Date.now();

function minutesAgo(minutes: number) {
  return new Date(now - minutes * 60_000).toISOString();
}

export const MUMBAI_REAL_HOSPITALS: HospitalLocationRef[] = [
  {
    id: 'HSP-MUM-001',
    name: 'Karuna Hospital',
    address: 'SVP Road, Dahisar West, Mumbai 400103',
    location: { lat: 19.2412176, lng: 72.8530350 },
  },
  {
    id: 'HSP-MUM-002',
    name: 'Sailee Hospital and Diagnostic Center',
    address: 'Link Road, Shimpoli, Borivali West, Mumbai 400091',
    location: { lat: 19.2277332, lng: 72.8406807 },
  },
  {
    id: 'HSP-MUM-003',
    name: 'Kokilaben Dhirubhai Ambani Hospital',
    address: 'Jai Prakash Road, Four Bungalows, Andheri West, Mumbai 400053',
    location: { lat: 19.1315526, lng: 72.8240127 },
  },
  {
    id: 'HSP-MUM-004',
    name: 'Lilavati Hospital and Research Centre',
    address: 'KC Marg, Bandra Reclamation, Bandra West, Mumbai 400050',
    location: { lat: 19.0509357, lng: 72.8291665 },
  },
  {
    id: 'HSP-MUM-005',
    name: 'Nanavati Hospital',
    address: 'SV Road, Vile Parle West, Mumbai 400057',
    location: { lat: 19.0958520, lng: 72.8396586 },
  },
  {
    id: 'HSP-MUM-006',
    name: 'Jaslok Hospital',
    address: 'Dr. G. Deshmukh Marg, Cumballa Hill, Mumbai 400026',
    location: { lat: 18.9734430, lng: 72.8091464 },
  },
  {
    id: 'HSP-MUM-007',
    name: 'Breach Candy Hospital',
    address: 'Bhulabhai Desai Road, Cumballa Hill, Mumbai 400026',
    location: { lat: 18.9725663, lng: 72.8042677 },
  },
  {
    id: 'HSP-MUM-008',
    name: 'P. D. Hinduja Hospital',
    address: 'SVS Road, Mahim West, Mumbai 400016',
    location: { lat: 19.0332238, lng: 72.8382311 },
  },
  {
    id: 'HSP-MUM-009',
    name: 'Seven Hills Hospital',
    address: 'Marol Maroshi Road, Andheri East, Mumbai 400059',
    location: { lat: 19.1177786, lng: 72.8780686 },
  },
  {
    id: 'HSP-MUM-010',
    name: 'KEM Hospital',
    address: 'Acharya Donde Marg, Parel, Mumbai 400012',
    location: { lat: 19.0015631, lng: 72.8421717 },
  },
];

const ACTIVE_DEMO_HOSPITAL = MUMBAI_REAL_HOSPITALS.find((hospital) => hospital.id === 'HSP-MUM-009') ?? MUMBAI_REAL_HOSPITALS[0];

export const DEMO_HOSPITAL: HospitalUnit = {
  id: ACTIVE_DEMO_HOSPITAL.id,
  name: ACTIVE_DEMO_HOSPITAL.name,
  address: ACTIVE_DEMO_HOSPITAL.address,
  phone: '+91 22 6767 6767',
  location: { ...ACTIVE_DEMO_HOSPITAL.location },
  beds: {
    totalBeds: 86,
    occupiedBeds: 61,
    icuTotal: 14,
    icuOccupied: 9,
  },
};

export const DEMO_DRIVERS: DriverUnit[] = [
  {
    id: 'DRV-201',
    callSign: 'Alpha-21',
    name: 'Aditya Salunkhe',
    vehicleNumber: 'MH-02-EM-4211',
    phone: '+91 98190 14021',
    linkedHospitalId: DEMO_HOSPITAL.id,
    status: 'available',
    occupied: false,
    location: { lat: 19.1108, lng: 72.8914 },
    speedKmph: 46,
    fuelPct: 78,
    lastPingAt: minutesAgo(1),
    pingIntervalSec: 6,
    secondsSincePing: 0,
  },
  {
    id: 'DRV-202',
    callSign: 'Alpha-22',
    name: 'Rahul Chauhan',
    vehicleNumber: 'MH-02-EM-7742',
    phone: '+91 98201 56088',
    linkedHospitalId: DEMO_HOSPITAL.id,
    status: 'available',
    occupied: false,
    location: { lat: 19.1213, lng: 72.876 },
    speedKmph: 52,
    fuelPct: 64,
    lastPingAt: minutesAgo(1),
    pingIntervalSec: 5,
    secondsSincePing: 0,
  },
  {
    id: 'DRV-203',
    callSign: 'Bravo-31',
    name: 'Nitin Pujari',
    vehicleNumber: 'MH-02-EM-3108',
    phone: '+91 97695 11934',
    linkedHospitalId: DEMO_HOSPITAL.id,
    status: 'available',
    occupied: false,
    location: { lat: 19.1052, lng: 72.8938 },
    speedKmph: 42,
    fuelPct: 81,
    lastPingAt: minutesAgo(2),
    pingIntervalSec: 8,
    secondsSincePing: 0,
  },
  {
    id: 'DRV-204',
    callSign: 'Charlie-17',
    name: 'Sagar Nalawade',
    vehicleNumber: 'MH-02-EM-9833',
    phone: '+91 98920 22377',
    linkedHospitalId: DEMO_HOSPITAL.id,
    status: 'available',
    occupied: false,
    location: { lat: 19.1198, lng: 72.8994 },
    speedKmph: 44,
    fuelPct: 55,
    lastPingAt: minutesAgo(2),
    pingIntervalSec: 7,
    secondsSincePing: 0,
  },
  {
    id: 'DRV-205',
    callSign: 'Delta-09',
    name: 'Manoj Patil',
    vehicleNumber: 'MH-02-EM-6621',
    phone: '+91 99200 67012',
    linkedHospitalId: DEMO_HOSPITAL.id,
    status: 'offline',
    occupied: false,
    location: { lat: 19.1006, lng: 72.8705 },
    speedKmph: 0,
    fuelPct: 39,
    lastPingAt: minutesAgo(23),
    pingIntervalSec: 10,
    secondsSincePing: 0,
  },
  {
    id: 'DRV-206',
    callSign: 'Echo-55',
    name: 'Farhan Shaikh',
    vehicleNumber: 'MH-02-EM-5518',
    phone: '+91 98207 77851',
    linkedHospitalId: DEMO_HOSPITAL.id,
    status: 'available',
    occupied: false,
    location: { lat: 19.1164, lng: 72.8811 },
    speedKmph: 47,
    fuelPct: 88,
    lastPingAt: minutesAgo(1),
    pingIntervalSec: 4,
    secondsSincePing: 0,
  },
  {
    id: 'DRV-207',
    callSign: 'Foxtrot-12',
    name: 'Harish Venkatesh',
    vehicleNumber: 'MH-02-EM-1299',
    phone: '+91 99878 44108',
    linkedHospitalId: DEMO_HOSPITAL.id,
    status: 'available',
    occupied: false,
    location: { lat: 19.1061, lng: 72.8783 },
    speedKmph: 36,
    fuelPct: 72,
    lastPingAt: minutesAgo(1),
    pingIntervalSec: 6,
    secondsSincePing: 0,
  },
  {
    id: 'DRV-208',
    callSign: 'Golf-08',
    name: 'Vikram Deshmukh',
    vehicleNumber: 'MH-02-EM-8870',
    phone: '+91 98204 55324',
    linkedHospitalId: DEMO_HOSPITAL.id,
    status: 'available',
    occupied: false,
    location: { lat: 19.1258, lng: 72.8891 },
    speedKmph: 40,
    fuelPct: 49,
    lastPingAt: minutesAgo(2),
    pingIntervalSec: 9,
    secondsSincePing: 0,
  },
];

export const DEMO_REQUESTS: PatientRequest[] = [
  {
    id: 'ER-1004',
    patientName: 'Asha M.',
    age: 63,
    severity: 'critical',
    symptom: 'Severe chest pain with breathlessness',
    address: 'LBS Marg, Kurla West',
    location: { lat: 19.0901, lng: 72.8794 },
    channel: 'whatsapp',
    reportedAt: minutesAgo(3),
    status: 'new',
    notes: 'Family sent ECG photo in WhatsApp thread.',
  },
  {
    id: 'ER-1002',
    patientName: 'Pratik S.',
    age: 29,
    severity: 'high',
    symptom: 'Road traffic injury, possible fracture',
    address: 'Western Express Highway, near Andheri flyover',
    location: { lat: 19.1285, lng: 72.8725 },
    channel: 'call-center',
    reportedAt: minutesAgo(9),
    status: 'triaged',
    hospitalId: DEMO_HOSPITAL.id,
    notes: 'Bystander call verified by control desk.',
  },
  {
    id: 'ER-1001',
    patientName: 'Naina R.',
    age: 47,
    severity: 'moderate',
    symptom: 'Dizziness and low blood pressure',
    address: 'JVLR, Powai signal',
    location: { lat: 19.1182, lng: 72.9054 },
    channel: 'mobile-app',
    reportedAt: minutesAgo(11),
    status: 'triaged',
    hospitalId: DEMO_HOSPITAL.id,
    notes: 'Nearest unit requested after tele-triage.',
  },
  {
    id: 'ER-1003',
    patientName: 'Imran K.',
    age: 58,
    severity: 'critical',
    symptom: 'Suspected stroke, speech slurring',
    address: 'Sahar Road, Chakala',
    location: { lat: 19.1075, lng: 72.864 },
    channel: 'call-center',
    reportedAt: minutesAgo(14),
    status: 'triaged',
    hospitalId: DEMO_HOSPITAL.id,
    notes: 'Onboard paramedic started pre-arrival protocol.',
  },
  {
    id: 'ER-0999',
    patientName: 'Priya J.',
    age: 34,
    severity: 'low',
    symptom: 'Minor laceration and bleeding control',
    address: 'MIDC, Andheri East',
    location: { lat: 19.1149, lng: 72.8629 },
    channel: 'whatsapp',
    reportedAt: minutesAgo(28),
    status: 'completed',
    assignedDriverId: 'DRV-201',
    hospitalId: DEMO_HOSPITAL.id,
    closedAt: minutesAgo(8),
    notes: 'Treated in ER and discharged after first aid.',
  },
];

export const DEMO_EVENTS: OpsEvent[] = [
  {
    id: 'EVT-1',
    at: minutesAgo(2),
    type: 'system',
    message: 'Live fleet synchronization healthy. Avg ping delay 6.2s.',
  },
  {
    id: 'EVT-2',
    at: minutesAgo(4),
    type: 'triage',
    message: 'ER-1003 triaged as CRITICAL and queued for immediate dispatch.',
    requestId: 'ER-1003',
  },
  {
    id: 'EVT-3',
    at: minutesAgo(7),
    type: 'triage',
    message: 'ER-1002 triaged as HIGH after call-center validation.',
    requestId: 'ER-1002',
  },
  {
    id: 'EVT-4',
    at: minutesAgo(9),
    type: 'triage',
    message: 'ER-1001 triaged as moderate and queued for dispatch.',
    requestId: 'ER-1001',
  },
  {
    id: 'EVT-5',
    at: minutesAgo(14),
    type: 'incoming',
    message: 'New critical WhatsApp case ER-1004 received at desk.',
    requestId: 'ER-1004',
  },
  {
    id: 'EVT-6',
    at: minutesAgo(19),
    type: 'capacity',
    message: 'One ICU bed released after transfer to step-down unit.',
  },
];

function clonePoint(point: { lat: number; lng: number }) {
  return {
    lat: point.lat,
    lng: point.lng,
  };
}

function offsetPoint(point: { lat: number; lng: number }, deltaLat: number, deltaLng: number) {
  return {
    lat: point.lat + deltaLat,
    lng: point.lng + deltaLng,
  };
}

function cloneHospital(hospital: HospitalUnit, override?: HospitalLocationRef): HospitalUnit {
  if (override) {
    return {
      ...hospital,
      id: override.id,
      name: override.name,
      address: override.address,
      phone: override.phone ?? hospital.phone,
      location: clonePoint(override.location),
      beds: { ...hospital.beds },
    };
  }

  return {
    ...hospital,
    location: clonePoint(hospital.location),
    beds: { ...hospital.beds },
  };
}

function cloneRoute(points: Array<{ lat: number; lng: number }> | undefined, deltaLat: number, deltaLng: number) {
  if (!points) {
    return undefined;
  }

  return points.map((point) => offsetPoint(point, deltaLat, deltaLng));
}

function cloneDriver(driver: DriverUnit, hospitalId: string, deltaLat: number, deltaLng: number): DriverUnit {
  return {
    ...driver,
    linkedHospitalId: hospitalId,
    location: offsetPoint(driver.location, deltaLat, deltaLng),
    assignment: driver.assignment
      ? {
          ...driver.assignment,
          route: cloneRoute(driver.assignment.route, deltaLat, deltaLng),
          hospitalRoute: cloneRoute(driver.assignment.hospitalRoute, deltaLat, deltaLng),
        }
      : undefined,
  };
}

function cloneRequest(request: PatientRequest, hospitalId: string, deltaLat: number, deltaLng: number): PatientRequest {
  return {
    ...request,
    hospitalId: request.hospitalId ? hospitalId : undefined,
    location: offsetPoint(request.location, deltaLat, deltaLng),
  };
}

function cloneEvent(event: OpsEvent): OpsEvent {
  return {
    ...event,
  };
}

export function isDemoHospitalAccount(hospitalId?: string, email?: string): boolean {
  const e = (email || '').toLowerCase().trim();
  const id = (hospitalId || '').toUpperCase().trim();

  if (e.endsWith('@codered.ai')) return true;
  const demoIds = ['HSP-APOLLO', 'HSP-LILAVATI', 'HSP-FORTIS', 'HSP-KOKILABEN', 'HSP-NANAVATI', 'HSP-RUBY', 'HSP-MUM-009', 'HSP-BVR1', 'HSP-BVR2'];
  return demoIds.includes(id);
}

export function createInitialHospitalOpsState(hospitalOverride?: HospitalLocationRef, isDemo: boolean = true): HospitalOpsState {
  const baseHospital = cloneHospital(DEMO_HOSPITAL, hospitalOverride);
  const deltaLat = baseHospital.location.lat - DEMO_HOSPITAL.location.lat;
  const deltaLng = baseHospital.location.lng - DEMO_HOSPITAL.location.lng;

  if (!isDemo) {
    const freshTotalBeds = hospitalOverride?.bedCapacity ?? baseHospital.beds.totalBeds ?? 50;
    return {
      hospital: {
        ...baseHospital,
        beds: {
          totalBeds: freshTotalBeds,
          occupiedBeds: 0,
          icuTotal: Math.round(freshTotalBeds * 0.2),
          icuOccupied: 0,
        },
      },
      drivers: [],
      requests: [],
      events: [
        {
          id: 'EVT-0',
          at: new Date().toISOString(),
          type: 'system',
          message: 'Hospital command desk initialized. Ready for emergency dispatch.',
        },
      ],
      nextRequestNumber: 1001,
      lastSimulationAt: new Date().toISOString(),
    };
  }

  return {
    hospital: baseHospital,
    drivers: DEMO_DRIVERS.map((driver) => cloneDriver(driver, baseHospital.id, deltaLat, deltaLng)),
    requests: DEMO_REQUESTS.map((request) => cloneRequest(request, baseHospital.id, deltaLat, deltaLng)),
    events: DEMO_EVENTS.map(cloneEvent),
    nextRequestNumber: 1005,
    lastSimulationAt: new Date().toISOString(),
  };
}
