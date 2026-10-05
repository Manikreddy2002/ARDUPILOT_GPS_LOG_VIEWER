# ArduPilot GPS Flight Log Analyzer & Viewer

A modern, high-precision web-based UAV flight log analysis dashboard specifically built for ArduPilot DataFlash (`.bin` and `.log`) telemetry files. Designed with a stealth **Black & Grey** tactical cockpit aesthetic.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FManikreddy2002%2FARDUPILOT_GPS_LOG_VIEWER)

---

## Key Features

### 1. Overall GPS Quality Verdict
* **Automated Evaluation**: Delivers an immediate sentence summarizing whether GPS performance throughout the flight was **GOOD**, **ACCEPTABLE WITH WARNINGS**, or **BAD**.
* **Health Scoring**: 0–100 weighted score evaluating 3D fix consistency, satellite counts, HDOP dilution, horizontal accuracy, and mid-flight fix drops.
* **Diagnostic Chips**: Highlights positive factors (continuous fix, strong constellations) and flags specific warnings (HDOP spikes, satellite dips).

### 2. Takeoff & Landing Precision Analysis
* **Sub-Meter Accuracy Measurement**: Calculates high-precision geodesic horizontal displacement between takeoff and touchdown points using the WGS-84 reference ellipsoid.
* **Vertical Drift**: Measures starting altitude, touchdown altitude, and net vertical drift ($\Delta\text{Alt}$) in both meters and centimeters.
* **3D Direct Vector**: Computes true straight-line Euclidean distance in 3D space with visual dashed vector overlays on the flight map.

### 3. Animated Quadcopter Drone Parser
* **Tactical Loading Screen**: While parsing binary DataFlash packets, an animated quadcopter drone hovers dynamically.
* **Realistic Rotor Dynamics**: 4 high-speed counter-rotating propellers with realistic semi-transparent motion blur discs.
* **Aviation Strobes**: Flashing port (red), starboard (green), and tail (white) navigation LEDs.
* **Telemetry Radar Sweep**: Elevated GPS antenna puck with pulsing satellite lock beacon and downward conical lidar/radar ground sweep.

### 4. Batch & Single Flight Log Modes
* **Daily Batch Upload**: Upload multiple logs simultaneously for daily flight operations.
* **Multi-Tab Interface**: Switch seamlessly between individual flight records and an aggregated batch overview.
* **All-Flights Map & Comparison Charts**: Overlay all trajectories on a single map and compare satellite count and HDOP across all flights.

### 5. Interactive Satellite Map
* Multi-layer map powered by Leaflet (Esri World Imagery, OpenStreetMap, CartoDB Dark).
* Color-coded trajectory by fix type (3D Fix, DGPS, RTK Float, RTK Fixed).
* Interactive takeoff and touchdown markers with coordinate tooltips.

---

## Project Structure

```text
ARDUPILOT_GPS_LOG_VIEWER/
├── api/
│   └── index.py            # Vercel serverless entrypoint
├── static/
│   ├── app.js              # Frontend logic, Leaflet map, Chart.js
│   └── style.css           # Black & Grey tactical theme, drone animations
├── templates/
│   └── index.html          # Dashboard UI template
├── server.py               # Flask application & PyMAVLink parser backend
├── requirements.txt        # Python dependencies
├── vercel.json             # Vercel deployment configuration
└── README.md
```

---

## Local Development

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Manikreddy2002/ARDUPILOT_GPS_LOG_VIEWER.git
   cd ARDUPILOT_GPS_LOG_VIEWER
   ```

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Run the server**:
   ```bash
   python server.py
   ```

4. Open your browser and navigate to:
   ```
   http://localhost:5000
   ```

---

## Deploy to Vercel

1. Push your code to GitHub:
   ```bash
   git push origin main
   ```
2. Go to [vercel.com](https://vercel.com) and log in.
3. Click **Add New...** -> **Project**.
4. Select `ARDUPILOT_GPS_LOG_VIEWER` from your GitHub repositories.
5. Keep default settings (Vercel automatically detects `vercel.json` and Python runtime).
6. Click **Deploy**.

---

## License

Open-source under the MIT License. Built for the ArduPilot & UAV developer community.
