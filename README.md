# CodeRedAI 🚨

**Author & Lead Architect**: Maxwell Mathew  
**Repository**: [https://github.com/Maxwell343/CodeRedAI.git](https://github.com/Maxwell343/CodeRedAI.git)

A production-grade emergency medical mobility and autonomous dispatch management system featuring real-time triage, driver routing, WhatsApp bot integration, and specialized portals for Hospitals, Drivers, and Administrators.

## Prerequisites

Before starting, ensure you have the following installed on your system:
- **Node.js** (v18 or higher)
- **Python** (v3.10 or higher)
- **Git**

---

## 🛠 Database Setup (MongoDB Atlas)

Since the project uses a shared MongoDB Atlas cluster, your IP address must be allowlisted before you can run the backend successfully.

### 1. Request Database Access
1. Ask the project owner (Maxwell) for the shared MongoDB Atlas credentials **OR** to be invited to the MongoDB Atlas project.
2. In the Atlas dashboard, navigate to **Security** -> **Network Access** on the left sidebar.
3. Click **"+ ADD IP ADDRESS"**.
4. Click **"ADD CURRENT IP ADDRESS"**, then click Confirm. 
> [!WARNING]
> If your IP is not in this list, the backend will fail to start and give a `503 Service Unavailable` error due to timeouts!

### 2. Get the Connection String
1. Go to **Database** on the left sidebar.
2. Click **Connect** on the cluster.
3. Choose **Drivers** (Python).
4. Copy the connection string. It will look like this:
   `mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority`

---

## 🚀 Local Development Setup

### 1. Clone the Repository
```bash
git clone https://github.com/Maxwell343/CodeRedAI.git
cd CodeRedAI
```

### 2. Backend Setup
We use FastAPI and Python. Open a terminal in the project root:

```bash
# Navigate to backend directory
cd backend

# Create a virtual environment (Windows)
python -m venv .venv
# Activate it (Windows)
.\.venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy the environment template
cp .env.example .env
```

**Configure Backend `backend/.env`:**
Open `.env` and fill in your details:
- `MONGO_URL`: Paste the Atlas DB string from the steps above (replace `<username>` and `<password>`).
- `JWT_SECRET`: Any random string (e.g. `mysecrettoken123`).

**Start Backend Server:**
```bash
uvicorn main:app --reload
```
The backend should now say `Application startup complete.` and run on `http://localhost:8000`.

### 3. Frontend Setup
We use React with Vite. Open a **new, separate terminal**:

```bash
# Navigate to the frontend directory
cd frontend

# Install Node dependencies
npm install

# Copy the environment template
cp .env.example .env
```

**Configure Frontend `frontend/.env`:**
The frontend `.env` just needs to point to your local backend. Ensure it has:
```
VITE_API_BASE_URL=http://localhost:8000
```

**Start Frontend Server:**
```bash
npm run dev
```

### 4. Verify Everything Works
- Open http://localhost:5173 in your browser.
- Go to the **Hospital** module.
- Create a new account — if it instantly navigates to the dashboard, your entire stack (Frontend ↔ Backend ↔ MongoDB Atlas) is connected perfectly!

---

## 🔐 Preset Demo Accounts
To speed up testing, the application has quick-fill demo accounts pre-seeded in the database:

- **Hospitals** (Default Password: `Password@123`):
  - `apollo.er@codered.ai` (Apollo Emergency Center)
  - `lilavati.er@codered.ai` (Lilavati Hospital ER)
  - `fortis.er@codered.ai` (Fortis Hospital ER)
  - `kokilaben.er@codered.ai` (Kokilaben Hospital ER)
  - `nanavati.er@codered.ai` (Nanavati Max ER)
  - `rubyhall.er@codered.ai` (Ruby Hall Clinic ER)

- **Drivers** (Default Password: `Password@123`):
  - `driver.rajesh@codered.ai` (Rajesh Kumar - AMB-101)
  - `driver.vikram@codered.ai` (Vikram Singh - AMB-102)
  - `driver.amit@codered.ai` (Amit Sharma - AMB-103)
  - `driver.suresh@codered.ai` (Suresh Patil - AMB-104)
  - `driver.priya@codered.ai` (Priya Deshmukh - AMB-105)
  - `driver.rohit@codered.ai` (Rohit Verma - AMB-106)

- **Admins** (Default Password: `Admin@123`):
  - `admin.ops@codered.ai` (Aarav Mehta - Chief Ops)
  - `admin.verify@codered.ai` (Siya Iyer - Verification Lead)
  - `admin.reviews@codered.ai` (Kabir Khan - Quality Admin)
  - `admin.compliance@codered.ai` (Neha Desai - Compliance Admin)