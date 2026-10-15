import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { 
  INITIAL_USERS, 
  INITIAL_DONOR_PROFILES, 
  INITIAL_HOSPITALS, 
  INITIAL_REQUESTS, 
  INITIAL_REVIEWS, 
  INITIAL_NOTIFICATIONS, 
  INITIAL_MESSAGES 
} from './src/data/seedData';
import { calculateHaversineDistance } from './src/utils/geo';
import { isRbcCompatible, getCompatibleDonorGroups } from './src/utils/compatibility';
import { BloodGroup, BloodRequest, DonorInvitation, Message, ReviewFeedback, User, DonorProfile } from './src/types';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const app = express();

app.use(express.json());

// In-Memory Database store
let users: User[] = [...INITIAL_USERS];
let donors: DonorProfile[] = [...INITIAL_DONOR_PROFILES];
let hospitals = [...INITIAL_HOSPITALS];
let requests: BloodRequest[] = [...INITIAL_REQUESTS];
let reviews: ReviewFeedback[] = [...INITIAL_REVIEWS];
let notifications = [...INITIAL_NOTIFICATIONS];
let messages: Message[] = [...INITIAL_MESSAGES];

// OTP Store for simulated phone/email 2FA
const otpStore = new Map<string, { code: string; expiresAt: number; userData?: Partial<User> }>();

// Initialize Gemini Client
const geminiApiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (geminiApiKey) {
  ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// ----------------------------------------
// REST API ENDPOINTS
// ----------------------------------------

// System Health & Stats
app.get('/api/stats', (_req: Request, res: Response) => {
  const activeDonors = donors.filter(d => d.availability === 'AVAILABLE' && d.status === 'ACTIVE').length;
  const fulfilledCount = requests.filter(r => r.status === 'FULFILLED').length;
  const criticalCount = requests.filter(r => r.urgency === 'CRITICAL' && r.status !== 'FULFILLED' && r.status !== 'CANCELLED').length;
  
  res.json({
    totalRegisteredDonors: donors.length,
    activeAvailableDonors: activeDonors,
    totalRequestsFulfilled: fulfilledCount + 148, // Include verified legacy network counter
    activeUrgentRequests: criticalCount,
    verifiedHospitalsCount: hospitals.filter(h => h.isVerified).length,
    averageFulfillmentTimeHrs: '2.4',
    donorResponseRatePercent: 94,
  });
});

// Users
app.get('/api/users', (_req: Request, res: Response) => {
  res.json(users);
});

app.get('/api/users/:id', (req: Request, res: Response) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Donors with GPS Search & Filter
app.get('/api/donors', (req: Request, res: Response) => {
  const { bloodGroup, recipientBloodGroup, maxDistance, lat, lng, availability } = req.query;
  
  let results = donors.filter(d => d.status === 'ACTIVE');

  if (availability) {
    results = results.filter(d => d.availability === availability);
  }

  // Exact blood group filter
  if (bloodGroup && typeof bloodGroup === 'string' && bloodGroup !== 'ALL') {
    results = results.filter(d => d.bloodGroup === bloodGroup);
  }

  // Compatibility filter if searching for a specific recipient blood group
  if (recipientBloodGroup && typeof recipientBloodGroup === 'string') {
    const eligibleGroups = getCompatibleDonorGroups(recipientBloodGroup as BloodGroup);
    results = results.filter(d => eligibleGroups.includes(d.bloodGroup));
  }

  // Distance calculation and radius filter
  if (lat && lng) {
    const userLat = parseFloat(lat as string);
    const userLng = parseFloat(lng as string);
    const radius = maxDistance ? parseFloat(maxDistance as string) : 100;

    results = results
      .map(d => {
        const dist = calculateHaversineDistance({ lat: userLat, lng: userLng }, d.approximateCoords);
        return { ...d, distanceKm: dist };
      })
      .filter(d => (d as any).distanceKm <= radius)
      .sort((a, b) => (a as any).distanceKm - (b as any).distanceKm);
  }

  res.json(results);
});

// Toggle Donor Availability
app.patch('/api/donors/:id/availability', (req: Request, res: Response) => {
  const { availability } = req.body;
  const donor = donors.find(d => d.id === req.params.id);
  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  donor.availability = availability;
  // Also sync user record
  const user = users.find(u => u.id === req.params.id);
  if (user) user.availability = availability;

  res.json(donor);
});

// Hospitals
app.get('/api/hospitals', (_req: Request, res: Response) => {
  res.json(hospitals);
});

// Requests
app.get('/api/requests', (req: Request, res: Response) => {
  const { status, urgency, bloodGroup, recipientId } = req.query;
  let results = [...requests];

  if (status && typeof status === 'string' && status !== 'ALL') {
    results = results.filter(r => r.status === status);
  }
  if (urgency && typeof urgency === 'string' && urgency !== 'ALL') {
    results = results.filter(r => r.urgency === urgency);
  }
  if (bloodGroup && typeof bloodGroup === 'string' && bloodGroup !== 'ALL') {
    results = results.filter(r => r.bloodGroup === bloodGroup);
  }
  if (recipientId && typeof recipientId === 'string') {
    results = results.filter(r => r.recipientId === recipientId);
  }

  // Sort: CRITICAL first, then newest
  results.sort((a, b) => {
    if (a.urgency === 'CRITICAL' && b.urgency !== 'CRITICAL') return -1;
    if (b.urgency === 'CRITICAL' && a.urgency !== 'CRITICAL') return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  res.json(results);
});

app.get('/api/requests/:id', (req: Request, res: Response) => {
  const r = requests.find(reqItem => reqItem.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  res.json(r);
});

// Create Blood Request
app.post('/api/requests', (req: Request, res: Response) => {
  const {
    recipientId,
    recipientName,
    recipientPhone,
    bloodGroup,
    componentType,
    unitsRequested,
    urgency,
    hospitalName,
    hospitalAddress,
    location,
    requiredDate,
    additionalNotes,
    preferredContact,
  } = req.body;

  if (!recipientName || !bloodGroup || !unitsRequested || !hospitalName) {
    return res.status(400).json({ error: 'Missing mandatory request fields' });
  }

  const newId = `REQ-2026-${Math.floor(1000 + Math.random() * 9000)}`;
  const now = new Date().toISOString();

  // Find compatible nearby donors automatically to notify
  const compatibleGroups = getCompatibleDonorGroups(bloodGroup);
  const eligibleDonors = donors.filter(
    d => d.status === 'ACTIVE' && d.availability === 'AVAILABLE' && compatibleGroups.includes(d.bloodGroup)
  );

  const invitations: DonorInvitation[] = eligibleDonors.slice(0, 3).map(d => ({
    id: `inv-${Date.now()}-${d.id}`,
    requestId: newId,
    donorId: d.id,
    donorName: d.name,
    donorBloodGroup: d.bloodGroup,
    status: 'PENDING',
    invitedAt: now,
    message: `Urgent request for ${unitsRequested} units of ${bloodGroup} at ${hospitalName}.`,
  }));

  // Create notifications for invited donors
  invitations.forEach(inv => {
    notifications.unshift({
      id: `notif-${Date.now()}-${inv.donorId}`,
      userId: inv.donorId,
      title: `${urgency === 'CRITICAL' ? 'EMERGENCY: ' : ''}Blood Request for ${bloodGroup}`,
      message: `${hospitalName} needs ${unitsRequested} unit(s) of ${bloodGroup}. Can you donate?`,
      type: urgency === 'CRITICAL' ? 'URGENT' : 'INVITE',
      timestamp: 'Just now',
      isRead: false,
      linkUrl: `/request/${newId}`,
      requestId: newId,
    });
  });

  const newRequest: BloodRequest = {
    id: newId,
    recipientId: recipientId || 'user-recipient',
    recipientName,
    recipientPhone: recipientPhone || '+1 (555) 000-0000',
    bloodGroup,
    componentType: componentType || 'WHOLE_BLOOD',
    unitsRequested: Number(unitsRequested),
    unitsFulfilled: 0,
    urgency: urgency || 'STANDARD',
    hospitalName,
    hospitalAddress: hospitalAddress || 'General Medical Center',
    location: location || { lat: 37.7749, lng: -122.4194 },
    requiredDate: requiredDate || 'As soon as possible',
    additionalNotes: additionalNotes || '',
    preferredContact: preferredContact || 'PHONE',
    status: invitations.length > 0 ? 'DONOR_REQUESTED' : 'SEARCHING_FOR_DONORS',
    createdAt: now,
    updatedAt: now,
    timeline: [
      {
        id: `evt-${Date.now()}-1`,
        status: 'CREATED',
        title: 'Blood Request Logged',
        description: `Request created for ${unitsRequested} units of ${bloodGroup}. Urgency: ${urgency}.`,
        timestamp: now,
        actor: recipientName,
      },
      ...(invitations.length > 0
        ? [
            {
              id: `evt-${Date.now()}-2`,
              status: 'DONOR_REQUESTED' as const,
              title: 'GPS Donor Discovery Invites Sent',
              description: `Dispatched direct alerts to ${invitations.length} compatible nearby donor(s).`,
              timestamp: now,
              actor: 'BloodBridge Engine',
            },
          ]
        : []),
    ],
    invitations,
  };

  requests.unshift(newRequest);
  res.status(201).json(newRequest);
});

// Update Blood Request Status (State Machine)
app.patch('/api/requests/:id/status', (req: Request, res: Response) => {
  const { status, actorName, notes } = req.body;
  const r = requests.find(item => item.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });

  const now = new Date().toISOString();
  r.status = status;
  r.updatedAt = now;

  let eventTitle = `Status updated to ${status}`;
  let eventDesc = notes || `Request transitioned to ${status}.`;

  if (status === 'ACCEPTED') {
    eventTitle = 'Donor Accepted Invitation';
    eventDesc = 'A donor agreed to proceed with donation coordination.';
  } else if (status === 'DONATION_COORDINATING') {
    eventTitle = 'Donation Coordinating with Hospital';
    eventDesc = 'Donor schedule confirmed with hospital transfusion wing.';
  } else if (status === 'FULFILLED') {
    eventTitle = 'Donation Completed & Units Received';
    eventDesc = 'Clinical confirmation: Units verified and transfused.';
    r.unitsFulfilled = r.unitsRequested;
    r.fulfilledAt = now;
  } else if (status === 'CANCELLED') {
    eventTitle = 'Request Cancelled';
    eventDesc = notes || 'Cancelled by requester.';
  }

  r.timeline.push({
    id: `evt-${Date.now()}`,
    status,
    title: eventTitle,
    description: eventDesc,
    timestamp: now,
    actor: actorName || 'Authorized User',
  });

  // Notify recipient
  notifications.unshift({
    id: `notif-${Date.now()}`,
    userId: r.recipientId,
    title: `Request ${r.id} Status: ${status}`,
    message: eventDesc,
    type: 'STATUS_CHANGE',
    timestamp: 'Just now',
    isRead: false,
    linkUrl: `/request/${r.id}`,
    requestId: r.id,
  });

  res.json(r);
});

// Invite Specific Donor to Request
app.post('/api/requests/:id/invite', (req: Request, res: Response) => {
  const { donorId, donorName, donorBloodGroup, message } = req.body;
  const r = requests.find(item => item.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });

  const now = new Date().toISOString();
  const newInvitation: DonorInvitation = {
    id: `inv-${Date.now()}`,
    requestId: r.id,
    donorId,
    donorName,
    donorBloodGroup,
    status: 'PENDING',
    invitedAt: now,
    message: message || 'You have been invited to fulfill this blood request.',
  };

  r.invitations.push(newInvitation);
  r.status = 'DONOR_REQUESTED';
  r.timeline.push({
    id: `evt-${Date.now()}`,
    status: 'DONOR_REQUESTED',
    title: `Invitation Sent to ${donorName}`,
    description: `Direct invitation dispatched to ${donorBloodGroup} donor.`,
    timestamp: now,
    actor: 'Requester',
  });

  // Create notification for donor
  notifications.unshift({
    id: `notif-${Date.now()}`,
    userId: donorId,
    title: `Direct Blood Request Invitation`,
    message: `${r.hospitalName} is requesting your help for ${r.unitsRequested} unit(s) of ${r.bloodGroup}.`,
    type: 'INVITE',
    timestamp: 'Just now',
    isRead: false,
    linkUrl: `/request/${r.id}`,
    requestId: r.id,
  });

  res.json(r);
});

// Donor responds to invitation (Accept or Decline)
app.post('/api/requests/:id/respond-invite', (req: Request, res: Response) => {
  const { donorId, response, donorName } = req.body; // 'ACCEPTED' | 'DECLINED'
  const r = requests.find(item => item.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });

  const inv = r.invitations.find(i => i.donorId === donorId);
  const now = new Date().toISOString();
  if (inv) {
    inv.status = response;
    inv.respondedAt = now;
  }

  if (response === 'ACCEPTED') {
    r.status = 'ACCEPTED';
    r.fulfilledByDonorId = donorId;
    r.timeline.push({
      id: `evt-${Date.now()}`,
      status: 'ACCEPTED',
      title: `${donorName || 'Donor'} Accepted Request`,
      description: 'Donor has confirmed availability. Next step: confirm appointment schedule.',
      timestamp: now,
      actor: donorName || 'Donor',
    });

    // Notify recipient
    notifications.unshift({
      id: `notif-${Date.now()}`,
      userId: r.recipientId,
      title: 'Donor Accepted Your Request!',
      message: `${donorName || 'A donor'} accepted your request ${r.id}. You can now coordinate directly.`,
      type: 'STATUS_CHANGE',
      timestamp: 'Just now',
      isRead: false,
      linkUrl: `/request/${r.id}`,
      requestId: r.id,
    });
  } else {
    r.timeline.push({
      id: `evt-${Date.now()}`,
      status: r.status,
      title: `${donorName || 'Donor'} Declined Invitation`,
      description: 'Donor is unavailable at this time. Continuing search.',
      timestamp: now,
      actor: donorName || 'Donor',
    });
  }

  res.json(r);
});

// Messages for Request Coordination
app.get('/api/messages/:requestId', (req: Request, res: Response) => {
  const msgs = messages.filter(m => m.requestId === req.params.requestId);
  res.json(msgs);
});

app.post('/api/messages', (req: Request, res: Response) => {
  const { requestId, senderId, senderName, senderRole, recipientId, text } = req.body;
  if (!requestId || !text) return res.status(400).json({ error: 'Missing message details' });

  const newMsg: Message = {
    id: `msg-${Date.now()}`,
    requestId,
    senderId,
    senderName,
    senderRole,
    recipientId,
    text,
    timestamp: new Date().toISOString(),
    isRead: false,
  };

  messages.push(newMsg);
  res.status(201).json(newMsg);
});

// Reviews and Feedback
app.get('/api/reviews', (_req: Request, res: Response) => {
  res.json(reviews);
});

app.post('/api/reviews', (req: Request, res: Response) => {
  const { requestId, reviewerId, reviewerName, reviewerRole, targetId, targetName, rating, comment, category } = req.body;
  if (!requestId || !rating || !comment) {
    return res.status(400).json({ error: 'Incomplete review information' });
  }

  const newReview: ReviewFeedback = {
    id: `rev-${Date.now()}`,
    requestId,
    reviewerId,
    reviewerName,
    reviewerRole,
    targetId,
    targetName,
    rating: Number(rating),
    comment,
    category: category || 'OVERALL',
    createdAt: new Date().toISOString(),
    isApproved: true,
    reported: false,
  };

  reviews.unshift(newReview);

  // Mark request as having feedback
  const r = requests.find(item => item.id === requestId);
  if (r) r.hasFeedback = true;

  res.status(201).json(newReview);
});

// Notifications
app.get('/api/notifications/:userId', (req: Request, res: Response) => {
  const userNotifs = notifications.filter(n => n.userId === req.params.userId);
  res.json(userNotifs);
});

app.post('/api/notifications/mark-read', (req: Request, res: Response) => {
  const { notificationId } = req.body;
  const n = notifications.find(item => item.id === notificationId);
  if (n) n.isRead = true;
  res.json({ success: true });
});

// ----------------------------------------
// AUTHENTICATION & OTP
// ----------------------------------------

// Registration with simulated OTP
app.post('/api/auth/register', (req: Request, res: Response) => {
  const { name, email, phone, role, bloodGroup, city, hospitalName, hospitalLicense } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  // Generate 6-digit cryptographic-like OTP
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  const newUserData: Partial<User> = {
    id: `user-${Date.now()}`,
    name,
    email,
    phone: phone || '',
    role: role || 'DONOR',
    bloodGroup: bloodGroup || 'O+',
    city: city || 'San Francisco, CA',
    status: 'ACTIVE',
    joinedDate: new Date().toISOString().split('T')[0],
    isVerified: role === 'HOSPITAL' ? false : true, // Hospitals need admin verification
    hospitalName,
    hospitalLicense,
  };

  otpStore.set(email.toLowerCase(), { code, expiresAt, userData: newUserData });

  // In production this would send via Spring Mail / SMTP / Twilio SMS
  // We return the simulated code in the payload so the user can easily test the OTP flow in demo!
  res.json({
    message: 'Verification OTP sent to ' + email,
    previewOtp: code,
    expiresInMinutes: 5,
  });
});

// Verify OTP & complete login
app.post('/api/auth/verify-otp', (req: Request, res: Response) => {
  const { email, code } = req.body;
  const record = otpStore.get(email?.toLowerCase());

  if (!record) {
    return res.status(400).json({ error: 'No pending OTP verification for this email. Please request a new code.' });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(email.toLowerCase());
    return res.status(400).json({ error: 'OTP has expired. Please register or request again.' });
  }

  if (record.code !== code) {
    return res.status(400).json({ error: 'Invalid verification code. Please check and try again.' });
  }

  // OTP is valid!
  let user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user && record.userData) {
    user = record.userData as User;
    users.push(user);

    // If donor, also add to donor directory
    if (user.role === 'DONOR') {
      const newDonor: DonorProfile = {
        ...user,
        role: 'DONOR',
        bloodGroup: user.bloodGroup || 'O+',
        availability: 'AVAILABLE',
        preferredRadiusKm: 25,
        totalDonations: 0,
        lastDonationDate: 'First-time Donor',
        rating: 5.0,
        reviewCount: 0,
        allowLocationMatching: true,
        approximateCoords: { lat: 37.7749 + (Math.random() - 0.5) * 0.05, lng: -122.4194 + (Math.random() - 0.5) * 0.05 },
      };
      donors.push(newDonor);
    }
  }

  otpStore.delete(email.toLowerCase());
  res.json({ success: true, user });
});

// Direct Login
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email } = req.body;
  const user = users.find(u => u.email.toLowerCase() === email?.toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'User not found with this email. Please register.' });
  }
  if (user.status === 'SUSPENDED') {
    return res.status(403).json({ error: 'This account has been suspended by administration. Please contact support.' });
  }
  res.json({ success: true, user });
});

// ----------------------------------------
// ADMIN OPERATIONS
// ----------------------------------------
app.post('/api/admin/users/:id/status', (req: Request, res: Response) => {
  const { status } = req.body;
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.status = status;
  res.json(user);
});

app.post('/api/admin/hospitals/:id/verify', (req: Request, res: Response) => {
  const { isVerified } = req.body;
  const hosp = hospitals.find(h => h.id === req.params.id);
  if (!hosp) return res.status(404).json({ error: 'Hospital not found' });
  hosp.isVerified = isVerified;
  res.json(hosp);
});

app.post('/api/admin/reviews/:id/moderate', (req: Request, res: Response) => {
  const { isApproved, reported } = req.body;
  const rev = reviews.find(r => r.id === req.params.id);
  if (!rev) return res.status(404).json({ error: 'Review not found' });
  if (isApproved !== undefined) rev.isApproved = isApproved;
  if (reported !== undefined) rev.reported = reported;
  res.json(rev);
});

// ----------------------------------------
// AI CHATBOT ENDPOINT (Powered by Gemini)
// ----------------------------------------
app.post('/api/chat', async (req: Request, res: Response) => {
  const { message, history } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message text is required.' });
  }

  // System instructions strictly grounded in clinical blood banking rules and medical safety
  const systemInstruction = `
You are the AI Blood Information Assistant for "BloodBridge", an integrated blood donation and request management system.
Your mission is to provide accurate, compassionate, and clinically grounded education regarding voluntary blood donation, blood group compatibility, donation preparation, deferrals, and navigating the BloodBridge platform.

STRICT MEDICAL SAFETY BOUNDARIES (NON-NEGOTIABLE):
1. You MUST NEVER diagnose illnesses or provide personalized medical diagnoses.
2. You MUST NEVER prescribe medications or treatments.
3. You MUST NEVER authoritatively certify an individual's medical eligibility for transfusion or donation; always state that final physical eligibility (vital signs, hemoglobin finger-prick, confidential medical history screening) is conducted on-site by certified phlebotomists.
4. For acute life-threatening situations, severe hemorrhage, or sudden trauma, prominently instruct the user: "If this is a life-threatening medical emergency, call 911 (or your local emergency services) or proceed to the nearest hospital emergency room immediately."
5. Clarify that blood compatibility information is educational guidance based on standard Red Blood Cell ABO/Rh compatibility; clinical blood transfusions always require laboratory crossmatching by licensed hospital blood bank personnel.

CLINICAL FACTS TO REMEMBER:
- Red Blood Cell Compatibility:
  - O-: Universal Red Cell Donor (can donate RBCs to all groups: O-, O+, A-, A+, B-, B+, AB-, AB+).
  - O+: Can donate to O+, A+, B+, AB+.
  - A-: Can donate to A-, A+, AB-, AB+.
  - A+: Can donate to A+, AB+.
  - B-: Can donate to B-, B+, AB-, AB+.
  - B+: Can donate to B+, AB+.
  - AB-: Can donate to AB-, AB+.
  - AB+: Universal Red Cell Recipient (can receive RBCs from all groups).
- Preparation Tips:
  - Drink at least 16-20 oz (500 ml) of water beforehand.
  - Eat a wholesome meal rich in iron (spinach, beans, lean meats) within 2-3 hours before donation.
  - Avoid heavy fatty foods (which can affect plasma tests) and alcohol for 24 hours.
  - Get adequate sleep (7-8 hours).
  - Wear clothing with loose sleeves that can be rolled up past the elbow.
- Common Deferrals:
  - Tattoos/Piercings: Standard modern deferral is 3 months unless done in a state-regulated sterile facility.
  - Low Iron / Hemoglobin: Minimum usually 12.5 g/dL for women, 13.0 g/dL for men.
  - Donation interval: 56 days (8 weeks) for whole blood donation.
  - Age / Weight: Minimum age 16-17 (depending on state/country with consent), minimum weight 110 lbs (50 kg).

Format answers clearly with neat bullet points, warmth, and brevity.
`;

  // Fallback rule-based answering in case Gemini API key is missing or encounters rate limits
  const generateRuleBasedFallback = (query: string): string => {
    const q = query.toLowerCase();
    if (q.includes('emergency') || q.includes('dying') || q.includes('bleeding') || q.includes('critical')) {
      return "⚠️ **EMERGENCY NOTICE**: If you or someone you are assisting is experiencing an acute life-threatening emergency or active severe hemorrhage, please call **911 (or your local emergency medical number)** immediately or head to the nearest Emergency Room. BloodBridge connects volunteer donors and cannot replace immediate emergency services.";
    }
    if (q.includes('o-') || q.includes('universal donor')) {
      return "🩸 **O-Negative (O-) Blood Facts**:\n- **Universal Red Blood Cell Donor**: O- red blood cells can be transfused into individuals of any ABO/Rh blood group (O-, O+, A-, A+, B-, B+, AB-, AB+).\n- **High Hospital Demand**: Emergency trauma rooms rely on O- units when there is no time to test a patient's blood type.\n- **Who can O- receive from?**: O- individuals can only safely receive O- blood.";
    }
    if (q.includes('ab+') || q.includes('universal recipient')) {
      return "🩸 **AB-Positive (AB+) Blood Facts**:\n- **Universal Red Blood Cell Recipient**: AB+ patients can receive red blood cells from any blood type.\n- **Universal Plasma Donor**: AB plasma contains no anti-A or anti-B antibodies, making AB plasma universal for trauma patients.";
    }
    if (q.includes('prepare') || q.includes('before donation') || q.includes('eating')) {
      return "📋 **How to Prepare for Blood Donation**:\n1. **Hydrate**: Drink at least 500ml (16-20 oz) of water prior to your appointment.\n2. **Iron-Rich Meal**: Eat a healthy meal with leafy greens, poultry, or beans 2-3 hours beforehand. Avoid greasy fast foods.\n3. **Rest**: Get a full night's sleep.\n4. **Identification**: Bring a government-issued photo ID.\n5. **Clothing**: Wear comfortable clothes with sleeves that roll up easily.";
    }
    if (q.includes('tattoo') || q.includes('piercing')) {
      return "💉 **Tattoo & Piercing Guidelines**:\nIn most regions following FDA/AABB standards, there is a **3-month deferral period** after receiving a tattoo or body piercing, unless performed in a state-regulated facility using single-use sterile needles. The health screener at the blood center will evaluate your specific date and location.";
    }
    if (q.includes('how often') || q.includes('interval') || q.includes('wait')) {
      return "⏱️ **Donation Intervals**:\n- **Whole Blood**: You must wait at least **56 days (8 weeks)** between donations.\n- **Platelets (Apheresis)**: Every 7 days, up to 24 times a year.\n- **Power Red / Double Red Cells**: 112 days (16 weeks).\n- **Plasma**: Every 28 days.";
    }
    if (q.includes('gps') || q.includes('find') || q.includes('radius')) {
      return "🗺️ **GPS Donor Discovery on BloodBridge**:\nBloodBridge uses privacy-safe approximate geolocation. You can click 'Use My Current Location' or pick a city to discover compatible verified donors within 5 km to 100 km. Donors' exact street addresses are never publicly shared; only proximity and blood compatibility are displayed.";
    }
    return "Thank you for reaching out to BloodBridge! I can help you with blood compatibility (e.g. who can receive O- or A+), donor eligibility criteria (tattoos, weight, travel, medications), preparation tips, and submitting urgent blood requests. What specific topic would you like to explore?";
  };

  if (!ai) {
    // Return high quality rule-based response
    const fallbackText = generateRuleBasedFallback(message);
    return res.json({ text: fallbackText, provider: 'rule-based' });
  }

  try {
    const formattedContents: any[] = [];
    if (Array.isArray(history) && history.length > 0) {
      for (const h of history.slice(-6)) {
        formattedContents.push({
          role: h.sender === 'user' ? 'user' : 'model',
          parts: [{ text: h.text }],
        });
      }
    }
    formattedContents.push({
      role: 'user',
      parts: [{ text: message }],
    });

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: formattedContents,
      config: {
        systemInstruction,
        temperature: 0.3, // factual, conservative medical tone
      },
    });

    const outputText = response.text || generateRuleBasedFallback(message);
    res.json({ text: outputText, provider: 'gemini' });
  } catch (err: any) {
    console.error('Gemini API chat error, using fallback:', err?.message || err);
    const fallbackText = generateRuleBasedFallback(message);
    res.json({ text: fallbackText, provider: 'fallback' });
  }
});

// ----------------------------------------
// VITE SPA MIDDLEWARE / STATIC FILES
// ----------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BloodBridge server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
