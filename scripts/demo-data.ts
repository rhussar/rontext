/**
 * Word lists for scripts/seed-demo.ts. Every company, school, person and
 * handle here is invented; only the cities are real (so the map tiles have
 * somewhere to point). Keep it that way — nothing in this file may name a
 * real person or a real employer.
 */

export const FIRST_NAMES = [
  "Aaliyah", "Adrian", "Aisha", "Alejandro", "Amara", "Amir", "Anika", "Arjun",
  "Beatriz", "Benedikt", "Bianca", "Callum", "Camila", "Cassius", "Chidi",
  "Clara", "Dario", "Deshawn", "Dilara", "Dmitri", "Elena", "Eli", "Emeka",
  "Esme", "Ezra", "Farah", "Felix", "Fiona", "Gabriel", "Greta", "Hana",
  "Hugo", "Idris", "Ines", "Isaac", "Ivy", "Jasper", "Jia", "Jonah", "Jordan",
  "Julien", "Kai", "Keiko", "Kenji", "Kwame", "Lars", "Leila", "Lena", "Leo",
  "Lucia", "Maeve", "Malik", "Marcus", "Mariam", "Mateo", "Maya", "Mikkel",
  "Mira", "Nadia", "Nikhil", "Noor", "Oliver", "Omar", "Oona", "Paulo",
  "Priya", "Quinn", "Rafael", "Rania", "Rhea", "Rosa", "Rowan", "Sable",
  "Samir", "Sana", "Santiago", "Selin", "Seo-yun", "Simone", "Soren", "Tariq",
  "Tessa", "Theo", "Tomas", "Uma", "Valentina", "Vikram", "Wren", "Xavier",
  "Yara", "Yusuf", "Zainab", "Zoe",
];

export const LAST_NAMES = [
  "Abara", "Achterberg", "Adeyemi", "Almeida", "Anand", "Arellano", "Bakker",
  "Banerjee", "Bergström", "Blackwood", "Calloway", "Castellanos", "Chowdhury",
  "Dahl", "Delacroix", "Dimitriou", "Draper", "Eberhardt", "Ekwueme", "Farrow",
  "Fernandes", "Fitzgerald", "Galloway", "Garza", "Haddad", "Halvorsen",
  "Hartley", "Ibarra", "Ishikawa", "Iyer", "Jacobsen", "Jankowski", "Kaur",
  "Keane", "Kimura", "Kowalczyk", "Lindqvist", "Lombardi", "Macallister",
  "Mahoney", "Marchetti", "Mendoza", "Mwangi", "Nakamura", "Novak", "Nwosu",
  "Okafor", "Oyelaran", "Pacheco", "Pedersen", "Quintero", "Rahman", "Ramaswamy",
  "Reinholt", "Rocha", "Rutherford", "Saito", "Salcedo", "Sandoval", "Schreiber",
  "Sienkiewicz", "Solberg", "Soto", "Takahashi", "Thibodeaux", "Torres",
  "Uddin", "Vasquez", "Verhoeven", "Villanueva", "Wachowski", "Whitaker",
  "Winterbourne", "Xiang", "Yilmaz", "Zapata", "Zielinski",
];

export type DemoCompany = { name: string; industry: string; weight: number };

/** Weight = how many people are likely to work there; the first few are hubs. */
export const COMPANIES: DemoCompany[] = [
  { name: "Northwind Analytics", industry: "Data", weight: 18 },
  { name: "Bluecrest Health", industry: "Healthcare", weight: 15 },
  { name: "Kestrel Robotics", industry: "Robotics", weight: 12 },
  { name: "Saltmarsh Capital", industry: "Venture capital", weight: 11 },
  { name: "Lumen Labs", industry: "Software", weight: 10 },
  { name: "Meridian Freight", industry: "Logistics", weight: 9 },
  { name: "Harbor & Vale", industry: "Consulting", weight: 8 },
  { name: "Polaris Payments", industry: "Fintech", weight: 8 },
  { name: "Aurora Learning", industry: "Education", weight: 7 },
  { name: "Fernline Biotech", industry: "Biotech", weight: 6 },
  { name: "Nimbus Cloudworks", industry: "Infrastructure", weight: 6 },
  { name: "Tidewater Energy", industry: "Energy", weight: 5 },
  { name: "Copperfield Media", industry: "Media", weight: 5 },
  { name: "Ashgrove Partners", industry: "Private equity", weight: 5 },
  { name: "Halcyon Mobility", industry: "Transport", weight: 4 },
  { name: "Brightwater Insurance", industry: "Insurance", weight: 4 },
  { name: "Stonebridge Advisory", industry: "Consulting", weight: 4 },
  { name: "Verdant Farms Co.", industry: "Agriculture", weight: 3 },
  { name: "Ironwood Manufacturing", industry: "Manufacturing", weight: 3 },
  { name: "Silverline Legal", industry: "Legal", weight: 3 },
  { name: "Beacon Civic Tech", industry: "Government", weight: 3 },
  { name: "Ember & Oak", industry: "Hospitality", weight: 3 },
  { name: "Larkspur Retail", industry: "Retail", weight: 3 },
  { name: "Greyhaven Security", industry: "Security", weight: 2 },
  { name: "Marrow Health", industry: "Healthcare", weight: 2 },
  { name: "Tessellate Design", industry: "Design", weight: 2 },
  { name: "Windrow Logistics", industry: "Logistics", weight: 2 },
  { name: "Zephyr Airlines", industry: "Aviation", weight: 2 },
  { name: "Cinder Games", industry: "Games", weight: 2 },
  { name: "Fathom Ocean Data", industry: "Climate", weight: 2 },
  { name: "Quillon", industry: "Software", weight: 2 },
  { name: "Redwood Signal", industry: "Telecom", weight: 1 },
  { name: "Summit Ledger", industry: "Accounting", weight: 1 },
  { name: "Pinecone Foods", industry: "Consumer", weight: 1 },
  { name: "Oriel Systems", industry: "Hardware", weight: 1 },
  { name: "Cobalt Bay Studios", industry: "Film", weight: 1 },
];

export type DemoSchool = { name: string; weight: number; degrees: string[] };

export const SCHOOLS: DemoSchool[] = [
  { name: "Westbrook School of Management", weight: 10, degrees: ["MBA"] },
  { name: "Calder Institute of Technology", weight: 6, degrees: ["BS, Computer Science", "MS, Electrical Engineering", "PhD, Robotics"] },
  { name: "Riverside State University", weight: 5, degrees: ["BA, Economics", "BS, Biology", "BA, Communications"] },
  { name: "Hollis College", weight: 4, degrees: ["BA, History", "BA, Political Science"] },
  { name: "Marlowe University", weight: 4, degrees: ["BS, Finance", "JD", "MPH"] },
  { name: "Northgate Polytechnic", weight: 3, degrees: ["BEng, Mechanical Engineering", "MS, Data Science"] },
  { name: "St. Aldric's College", weight: 2, degrees: ["BA, Philosophy", "BA, English"] },
  { name: "Eastmere University", weight: 3, degrees: ["BS, Chemistry", "MD"] },
  { name: "Bayview Business School", weight: 3, degrees: ["MBA", "MS, Marketing"] },
  { name: "Tanager University", weight: 2, degrees: ["BFA, Design", "MArch"] },
];

export type DemoCity = { name: string; lat: number; lon: number; weight: number };

export const CITIES: DemoCity[] = [
  { name: "New York, NY", lat: 40.7128, lon: -74.006, weight: 14 },
  { name: "San Francisco, CA", lat: 37.7749, lon: -122.4194, weight: 10 },
  { name: "Boston, MA", lat: 42.3601, lon: -71.0589, weight: 8 },
  { name: "Chicago, IL", lat: 41.8781, lon: -87.6298, weight: 5 },
  { name: "Los Angeles, CA", lat: 34.0522, lon: -118.2437, weight: 5 },
  { name: "Austin, TX", lat: 30.2672, lon: -97.7431, weight: 4 },
  { name: "Seattle, WA", lat: 47.6062, lon: -122.3321, weight: 4 },
  { name: "Denver, CO", lat: 39.7392, lon: -104.9903, weight: 3 },
  { name: "Washington, DC", lat: 38.9072, lon: -77.0369, weight: 3 },
  { name: "Miami, FL", lat: 25.7617, lon: -80.1918, weight: 2 },
  { name: "Atlanta, GA", lat: 33.749, lon: -84.388, weight: 2 },
  { name: "Toronto, Canada", lat: 43.6532, lon: -79.3832, weight: 3 },
  { name: "London, United Kingdom", lat: 51.5074, lon: -0.1278, weight: 5 },
  { name: "Berlin, Germany", lat: 52.52, lon: 13.405, weight: 2 },
  { name: "Paris, France", lat: 48.8566, lon: 2.3522, weight: 2 },
  { name: "Amsterdam, Netherlands", lat: 52.3676, lon: 4.9041, weight: 2 },
  { name: "Dublin, Ireland", lat: 53.3498, lon: -6.2603, weight: 1 },
  { name: "Singapore", lat: 1.3521, lon: 103.8198, weight: 2 },
  { name: "Sydney, Australia", lat: -33.8688, lon: 151.2093, weight: 1 },
  { name: "Tokyo, Japan", lat: 35.6762, lon: 139.6503, weight: 1 },
  { name: "Mexico City, Mexico", lat: 19.4326, lon: -99.1332, weight: 1 },
  { name: "São Paulo, Brazil", lat: -23.5505, lon: -46.6333, weight: 1 },
  { name: "Bengaluru, India", lat: 12.9716, lon: 77.5946, weight: 1 },
  { name: "Lisbon, Portugal", lat: 38.7223, lon: -9.1393, weight: 1 },
  { name: "Zurich, Switzerland", lat: 47.3769, lon: 8.5417, weight: 1 },
];

export const TITLES: { title: string; weight: number }[] = [
  { title: "Software Engineer", weight: 8 },
  { title: "Senior Software Engineer", weight: 6 },
  { title: "Product Manager", weight: 7 },
  { title: "Senior Product Manager", weight: 4 },
  { title: "Founder & CEO", weight: 4 },
  { title: "Co-founder", weight: 3 },
  { title: "VP Engineering", weight: 2 },
  { title: "Data Scientist", weight: 5 },
  { title: "Investment Associate", weight: 3 },
  { title: "Principal", weight: 2 },
  { title: "Partner", weight: 2 },
  { title: "Marketing Lead", weight: 3 },
  { title: "Head of Design", weight: 2 },
  { title: "Product Designer", weight: 4 },
  { title: "Management Consultant", weight: 4 },
  { title: "Operations Manager", weight: 3 },
  { title: "Analyst", weight: 4 },
  { title: "Chief of Staff", weight: 2 },
  { title: "Recruiter", weight: 2 },
  { title: "Account Executive", weight: 4 },
  { title: "Research Scientist", weight: 3 },
  { title: "Program Manager", weight: 3 },
  { title: "Director of Sales", weight: 2 },
  { title: "General Counsel", weight: 1 },
  { title: "Finance Manager", weight: 2 },
  { title: "Engineering Manager", weight: 3 },
  { title: "Growth Lead", weight: 2 },
  { title: "Customer Success Manager", weight: 3 },
  { title: "Strategy Associate", weight: 2 },
  { title: "Staff Engineer", weight: 2 },
];

export const TAGLINES = [
  "building tools for people who network on purpose",
  "ex-{other}",
  "angel investor",
  "marathoner",
  "writing about climate tech",
  "hiring across engineering",
  "podcast host",
  "advisor to early-stage founders",
  "speaker",
  "open to collaborations",
  "dad of two",
  "amateur baker",
];

export const EVENTS = [
  "the Westbrook alumni mixer",
  "the fintech meetup in Brooklyn",
  "the climate tech dinner",
  "a friend's birthday",
  "the product leaders breakfast",
  "the Kestrel demo day",
  "the Saltmarsh portfolio offsite",
  "a panel on AI in healthcare",
  "the design systems conference",
  "a hackathon",
];

export const TOPICS = [
  "hiring a first PM",
  "moving into venture",
  "the freight pricing model",
  "her fundraise",
  "his podcast",
  "the Series A deck",
  "pricing experiments",
  "relocating to London",
  "the new robotics lab",
  "carbon accounting standards",
  "a board seat",
  "the go-to-market plan",
  "an intro to Saltmarsh",
  "the mentorship program",
];

export const NOTE_TEMPLATES = [
  "Met at {event}. {first} is thinking about {topic} — offered to intro to {other}.",
  "Coffee with {first}. Big topic: {topic}. Wants to reconnect next quarter.",
  "{first} reached out about {topic}. Sent over the notes from last time.",
  "Bumped into {first} at {event}. New role suits them. Follow up on {topic}.",
  "Long call. {first} is weighing {topic}; I said I'd share what worked for us.",
  "Intro from {other}. {first} is sharp on {topic}. Worth keeping close.",
  "Dinner after {event}. {first} offered to review the {topic} plan.",
  "{first} is moving to {city} in the spring. Book a farewell drink.",
  "Panel together at {event}. {first} was the best speaker on {topic}.",
  "Quick check-in. {first} asked for a reference for {other}. Done.",
];

export const IMPORTED_NOTES = [
  "Met through {other}. Warm intro, {topic}.",
  "Old teammate. Good at {topic}.",
  "Investor contact — {topic}.",
  "Classmate. Lives in {city}.",
  "Recruiter who placed {other}.",
  "Conference contact, {event}.",
];

export const REMINDER_BODIES = [
  "Send the deck",
  "Follow up on the intro to {other}",
  "Congratulate on the new role",
  "Book coffee — they're in town",
  "Reply about the panel invite",
  "Share the hiring doc",
  "Check in after the fundraise closes",
  "Send birthday note",
  "Ask about {topic}",
  "Return the book",
];

export type DraftSeed = {
  channel: "email" | "sms" | "linkedin";
  subject: string | null;
  body: string;
  ai?: boolean;
  sent?: boolean;
};

export const DRAFT_SEEDS: DraftSeed[] = [
  {
    channel: "email",
    subject: "Catching up + a small ask",
    body: "Hi {first},\n\nGreat seeing you at {event} last week. I keep thinking about what you said on {topic}.\n\nWould you have 20 minutes in the next couple of weeks? I'd love your take on something we're weighing.\n\nSam",
  },
  {
    channel: "linkedin",
    subject: null,
    body: "{first} — congrats on the new role at {company}! Long overdue. Let's get that coffee on the calendar.",
  },
  {
    channel: "sms",
    subject: null,
    body: "Hey {first}, it's Sam. Are you around Thursday? A few of us from Westbrook are meeting up near Union Square.",
  },
  {
    channel: "email",
    subject: "Intro: {first} <> {other}",
    body: "{first}, meet {other}. You two are circling the same problem on {topic} from opposite ends, and I think you'd enjoy comparing notes.\n\nI'll step back and let you take it from here.\n\nSam",
    ai: true,
  },
  {
    channel: "linkedin",
    subject: null,
    body: "Hi {first}, thanks again for the thoughtful questions after the panel. Happy to send over the slides — what's the best email?",
  },
  {
    channel: "email",
    subject: "Thank you",
    body: "{first},\n\nThank you for making time yesterday. The point about {topic} reframed the whole plan for me.\n\nI'll send an update once we've decided.\n\nSam",
    sent: true,
  },
  {
    channel: "sms",
    subject: null,
    body: "Landed safely — thanks for the ride to the airport, {first}!",
    sent: true,
  },
];

/** Title → the title a LinkedIn re-scrape would find after a promotion. */
export const PROMOTIONS: Record<string, string> = {
  "Software Engineer": "Senior Software Engineer",
  "Senior Software Engineer": "Staff Engineer",
  "Product Manager": "Senior Product Manager",
  "Senior Product Manager": "Director of Product",
  "Analyst": "Senior Analyst",
  "Investment Associate": "Principal",
  "Product Designer": "Head of Design",
  "Engineering Manager": "VP Engineering",
  "Marketing Lead": "Head of Marketing",
  "Co-founder": "Co-founder & CEO",
  "Account Executive": "Senior Account Executive",
  "Data Scientist": "Lead Data Scientist",
  "Management Consultant": "Engagement Manager",
  "Strategy Associate": "Strategy Manager",
};

export const SOCIAL_POSTS: {
  platform: "linkedin" | "x" | "instagram";
  body: string;
  posted: boolean;
  ai?: boolean;
}[] = [
  {
    platform: "linkedin",
    body: "Three years ago I started keeping a plain list of everyone I'd want to call if I lost my job tomorrow.\n\nIt is now the most valuable document I own — not because of the names, but because of the notes next to them. What we talked about. What they were worried about. What I promised.\n\nNetworking isn't collecting people. It's remembering them.",
    posted: true,
  },
  {
    platform: "x",
    body: "hot take: the best CRM for your career is the one you'll actually open on a Tuesday",
    posted: true,
  },
  {
    platform: "instagram",
    body: "Westbrook reunion weekend. Same people, slightly better coffee. ☕",
    posted: true,
  },
  {
    platform: "linkedin",
    body: "Draft: what I learned running 40 coffee chats in 90 days (and why I'd do 20 next time).",
    posted: false,
    ai: true,
  },
  {
    platform: "x",
    body: "reminder to future me: reply to the intro email the same day. every single time it aged badly.",
    posted: false,
  },
  {
    platform: "linkedin",
    body: "Hiring: we're looking for a founding designer at Lumen Labs. If you know someone who sketches on napkins at dinner, send them my way.",
    posted: false,
  },
];

export const APPLICATIONS: {
  company: string;
  role: string;
  daysAgo: number | null;
  notes: string;
}[] = [
  {
    company: "Lumen Labs",
    role: "Head of Product",
    daysAgo: 6,
    notes: "Referred by Priya. Recruiter screen Tuesday. Bring the freight case study.",
  },
  {
    company: "Polaris Payments",
    role: "Group Product Manager, Payments",
    daysAgo: 13,
    notes: "Take-home due Friday. Ask about the org chart — three PMs report to whom?",
  },
  {
    company: "Saltmarsh Capital",
    role: "Platform Lead",
    daysAgo: 21,
    notes: "Coffee with a partner went well. Waiting on the associate's follow-up.",
  },
  {
    company: "Aurora Learning",
    role: "Director of Product",
    daysAgo: 34,
    notes: "Rejected after the panel — too early-stage for what they need. Stay in touch with Omar.",
  },
  {
    company: "Kestrel Robotics",
    role: "Product Lead, Fleet",
    daysAgo: null,
    notes: "Not applied yet. Rafael said the posting goes up next month.",
  },
];

export const PERSONA = {
  name: "Sam Rivera",
  first: "Sam",
  workspaceName: "Sam's network",
  workspaceColor: "ocean",
  linkedin: {
    handle: "samrivera-demo",
    bio: "Product lead · Westbrook MBA · building tools for people who network on purpose",
  },
  x: { handle: "samrivera_demo", bio: "product, people, and the notes in between" },
  instagram: { handle: "samrivera.demo", bio: "coffee, trails, occasional charts" },
  youtube: { handle: "samrivera-demo", bio: "" },
  githubRepo: "samrivera-demo/network-notes",
} as const;
