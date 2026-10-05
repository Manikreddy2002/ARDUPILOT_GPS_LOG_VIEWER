#!/usr/bin/env python3
"""
ArduPilot GPS Log Analyzer — Local web server for analyzing GPS data
from ArduPilot DataFlash (.bin / .log) flight logs.

Parses GPS, GPA, and UBX messages and serves an interactive dashboard.
"""

import json
import os
import tempfile
import traceback
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, render_template, request
from pymavlink import mavutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static'),
)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500 MB max upload

UPLOAD_FOLDER = os.environ.get('UPLOAD_FOLDER', os.path.join(tempfile.gettempdir(), 'gps_analyzer_uploads'))
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


# GPS fix type enum matching AP_GPS_FixType
GPS_FIX_TYPES = {
    0: 'No GPS',
    1: 'No Fix',
    2: '2D Fix',
    3: '3D Fix',
    4: 'DGPS',
    5: 'RTK Float',
    6: 'RTK Fixed',
}


def gps_week_to_datetime(gps_week, gps_week_ms):
    """Convert GPS week and milliseconds to UTC datetime."""
    gps_epoch = datetime(1980, 1, 6, tzinfo=timezone.utc)
    delta = timedelta(weeks=gps_week, milliseconds=gps_week_ms)
    # GPS time is ahead of UTC by the number of leap seconds (currently 18)
    return gps_epoch + delta - timedelta(seconds=18)


def parse_log(filepath):
    """Parse an ArduPilot DataFlash log and extract GPS-related messages."""

    mlog = mavutil.mavlink_connection(filepath, dialect='ardupilotmega')

    gps_data = []
    gpa_data = []
    ubx1_data = []
    ubx2_data = []

    msg_types = set()
    total_msgs = 0

    while True:
        msg = mlog.recv_match(
            type=['GPS', 'GPA', 'UBX1', 'UBX2'],
            blocking=False
        )
        if msg is None:
            break

        total_msgs += 1
        msg_type = msg.get_type()
        msg_types.add(msg_type)
        d = msg.to_dict()
        # Remove mavpackettype key
        d.pop('mavpackettype', None)

        if msg_type == 'GPS':
            raw_lat = float(d.get('Lat', 0))
            raw_lng = float(d.get('Lng', 0))
            # Handle possible unscaled 1e7 values
            if abs(raw_lat) > 180:
                raw_lat /= 1e7
            if abs(raw_lng) > 180:
                raw_lng /= 1e7

            raw_alt = float(d.get('Alt', 0))
            # If alt looks like centimeters (>50000m is unrealistic for standard UAV), convert to m
            if abs(raw_alt) > 50000:
                raw_alt /= 100.0

            entry = {
                'time_us': d.get('TimeUS', 0),
                'instance': d.get('I', 0),
                'status': int(d.get('Status', 0)),
                'status_label': GPS_FIX_TYPES.get(int(d.get('Status', 0)), 'Unknown'),
                'gps_week_ms': d.get('GMS', 0),
                'gps_week': d.get('GWk', 0),
                'num_sats': int(d.get('NSats', 0)),
                'hdop': round(float(d.get('HDop', 0)), 2),
                'lat': round(raw_lat, 7),
                'lng': round(raw_lng, 7),
                'alt': round(raw_alt, 2),
                'speed': round(float(d.get('Spd', 0)), 2),
                'ground_course': round(float(d.get('GCrs', 0)), 2),
                'vel_z': round(float(d.get('VZ', 0)), 2),
                'yaw': round(float(d.get('Yaw', 0)), 2),
                'used': int(d.get('U', 0)),
            }
            # Compute a relative time in seconds from time_us
            entry['time_s'] = round(entry['time_us'] / 1e6, 3)
            # Compute UTC datetime if we have GPS week info
            if entry['gps_week'] > 0 and entry['gps_week_ms'] > 0:
                try:
                    dt = gps_week_to_datetime(entry['gps_week'],
                                              entry['gps_week_ms'])
                    entry['datetime'] = dt.isoformat()
                except Exception:
                    entry['datetime'] = None
            else:
                entry['datetime'] = None
            gps_data.append(entry)

        elif msg_type == 'GPA':
            entry = {
                'time_us': d.get('TimeUS', 0),
                'instance': d.get('I', 0),
                'vdop': round(float(d.get('VDop', 0)), 2),
                'hacc': round(float(d.get('HAcc', 0)), 2),
                'vacc': round(float(d.get('VAcc', 0)), 2),
                'sacc': round(float(d.get('SAcc', 0)), 2),
                'yacc': round(float(d.get('YAcc', 0)), 4),
                'have_vv': int(d.get('VV', 0)),
                'sample_ms': d.get('SMS', 0),
                'delta_ms': d.get('Delta', 0),
            }
            entry['time_s'] = round(entry['time_us'] / 1e6, 3)
            gpa_data.append(entry)

        elif msg_type == 'UBX1':
            entry = {
                'time_us': d.get('TimeUS', 0),
                'instance': d.get('Instance', 0),
                'noise_per_ms': d.get('noisePerMS', 0),
                'jam_ind': d.get('jamInd', 0),
                'a_power': d.get('aPower', 0),
                'agc_cnt': d.get('agcCnt', 0),
            }
            entry['time_s'] = round(entry['time_us'] / 1e6, 3)
            ubx1_data.append(entry)

        elif msg_type == 'UBX2':
            entry = {
                'time_us': d.get('TimeUS', 0),
                'instance': d.get('Instance', 0),
                'ofs_i': d.get('ofsI', 0),
                'mag_i': d.get('magI', 0),
                'ofs_q': d.get('ofsQ', 0),
                'mag_q': d.get('magQ', 0),
            }
            entry['time_s'] = round(entry['time_us'] / 1e6, 3)
            ubx2_data.append(entry)

    # --- Compute summary statistics ---
    summary = compute_summary(gps_data, gpa_data)

    return {
        'gps': gps_data,
        'gpa': gpa_data,
        'ubx1': ubx1_data,
        'ubx2': ubx2_data,
        'summary': summary,
        'msg_types_found': sorted(msg_types),
        'total_gps_msgs': len(gps_data),
        'total_gpa_msgs': len(gpa_data),
    }


def compute_summary(gps_data, gpa_data):
    """Compute summary statistics from parsed GPS data."""
    if not gps_data:
        return {}

    sats = [g['num_sats'] for g in gps_data]
    hdops = [g['hdop'] for g in gps_data if g['hdop'] > 0]
    speeds = [g['speed'] for g in gps_data]
    alts = [g['alt'] for g in gps_data]
    statuses = [g['status'] for g in gps_data]

    # Fix type distribution
    fix_dist = {}
    for s in statuses:
        label = GPS_FIX_TYPES.get(s, f'Unknown({s})')
        fix_dist[label] = fix_dist.get(label, 0) + 1

    # Time span
    time_span_s = gps_data[-1]['time_s'] - gps_data[0]['time_s']

    summary = {
        'total_samples': len(gps_data),
        'time_span_s': round(time_span_s, 1),
        'time_span_min': round(time_span_s / 60.0, 2),
        'sats_min': min(sats),
        'sats_max': max(sats),
        'sats_avg': round(sum(sats) / len(sats), 1),
        'hdop_min': round(min(hdops), 2) if hdops else 0,
        'hdop_max': round(max(hdops), 2) if hdops else 0,
        'hdop_avg': round(sum(hdops) / len(hdops), 2) if hdops else 0,
        'speed_max': round(max(speeds), 2),
        'speed_avg': round(sum(speeds) / len(speeds), 2),
        'alt_min': round(min(alts), 2),
        'alt_max': round(max(alts), 2),
        'fix_distribution': fix_dist,
        'best_fix': GPS_FIX_TYPES.get(max(statuses), 'Unknown'),
        'worst_fix': GPS_FIX_TYPES.get(min(statuses), 'Unknown'),
        'pct_3d_or_better': round(
            sum(1 for s in statuses if s >= 3) / len(statuses) * 100, 1
        ),
    }

    # Track metrics: distance, valid GPS points, start/end
    valid_pts = [g for g in gps_data if abs(g['lat']) > 0.0001 and abs(g['lng']) > 0.0001 and g['status'] >= 2]
    summary['valid_gps_points'] = len(valid_pts)
    if valid_pts:
        import math
        total_dist = 0.0
        for i in range(1, len(valid_pts)):
            p0 = valid_pts[i - 1]
            p1 = valid_pts[i]
            # Haversine distance
            lat1, lon1 = math.radians(p0['lat']), math.radians(p0['lng'])
            lat2, lon2 = math.radians(p1['lat']), math.radians(p1['lng'])
            dlat = lat2 - lat1
            dlon = lon2 - lon1
            a = math.sin(dlat / 2.0)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0)**2
            c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
            d = 6371000.0 * c
            # Filter unrealistic GPS teleports (>1000m between consecutive samples)
            if d < 1000.0:
                total_dist += d

        summary['distance_m'] = round(total_dist, 1)
        summary['distance_km'] = round(total_dist / 1000.0, 2)
        summary['start_lat'] = valid_pts[0]['lat']
        summary['start_lng'] = valid_pts[0]['lng']
        summary['end_lat'] = valid_pts[-1]['lat']
        summary['end_lng'] = valid_pts[-1]['lng']
        lats = [p['lat'] for p in valid_pts]
        lngs = [p['lng'] for p in valid_pts]
        summary['lat_min'] = min(lats)
        summary['lat_max'] = max(lats)
        summary['lng_min'] = min(lngs)
        summary['lng_max'] = max(lngs)

        # Start and ending altitude + difference (drift)
        start_alt = float(valid_pts[0]['alt'])
        end_alt = float(valid_pts[-1]['alt'])
        alt_diff = end_alt - start_alt
        summary['start_alt'] = round(start_alt, 2)
        summary['end_alt'] = round(end_alt, 2)
        summary['alt_diff'] = round(alt_diff, 2)
        summary['alt_diff_cm'] = round(alt_diff * 100.0, 1)

        # High-precision WGS-84 geodesic distance between takeoff and landing points (sub-meter accuracy)
        lat1_rad = math.radians(valid_pts[0]['lat'])
        lat2_rad = math.radians(valid_pts[-1]['lat'])
        lon1_rad = math.radians(valid_pts[0]['lng'])
        lon2_rad = math.radians(valid_pts[-1]['lng'])
        mean_lat = (lat1_rad + lat2_rad) / 2.0

        # WGS-84 principal radii of curvature
        a_wgs = 6378137.0
        b_wgs = 6356752.314245
        e_sq = 1.0 - (b_wgs / a_wgs)**2
        sin_lat = math.sin(mean_lat)
        r_lat = a_wgs * (1.0 - e_sq) / ((1.0 - e_sq * sin_lat**2)**1.5)
        r_lon = a_wgs / math.sqrt(1.0 - e_sq * sin_lat**2)

        dx = (lon2_rad - lon1_rad) * r_lon * math.cos(mean_lat)
        dy = (lat2_rad - lat1_rad) * r_lat
        takeoff_to_landing_dist_m = math.sqrt(dx * dx + dy * dy)
        takeoff_to_landing_3d_m = math.sqrt(dx * dx + dy * dy + alt_diff * alt_diff)

        summary['takeoff_to_landing_dist_m'] = round(takeoff_to_landing_dist_m, 3)
        summary['takeoff_to_landing_dist_cm'] = round(takeoff_to_landing_dist_m * 100.0, 1)
        summary['takeoff_to_landing_3d_m'] = round(takeoff_to_landing_3d_m, 3)
        summary['takeoff_to_landing_3d_cm'] = round(takeoff_to_landing_3d_m * 100.0, 1)
    else:
        summary['distance_m'] = 0.0
        summary['distance_km'] = 0.0
        summary['start_alt'] = 0.0
        summary['end_alt'] = 0.0
        summary['alt_diff'] = 0.0
        summary['alt_diff_cm'] = 0.0
        summary['takeoff_to_landing_dist_m'] = 0.0
        summary['takeoff_to_landing_dist_cm'] = 0.0
        summary['takeoff_to_landing_3d_m'] = 0.0
        summary['takeoff_to_landing_3d_cm'] = 0.0

    # GPA accuracy stats
    if gpa_data:
        haccs = [g['hacc'] for g in gpa_data if g['hacc'] > 0]
        vaccs = [g['vacc'] for g in gpa_data if g['vacc'] > 0]
        vdops = [g['vdop'] for g in gpa_data if g['vdop'] > 0]
        deltas = [g['delta_ms'] for g in gpa_data if g['delta_ms'] > 0]

        if haccs:
            summary['hacc_min'] = round(min(haccs), 2)
            summary['hacc_max'] = round(max(haccs), 2)
            summary['hacc_avg'] = round(sum(haccs) / len(haccs), 2)
        if vaccs:
            summary['vacc_min'] = round(min(vaccs), 2)
            summary['vacc_max'] = round(max(vaccs), 2)
            summary['vacc_avg'] = round(sum(vaccs) / len(vaccs), 2)
        if vdops:
            summary['vdop_min'] = round(min(vdops), 2)
            summary['vdop_max'] = round(max(vdops), 2)
            summary['vdop_avg'] = round(sum(vdops) / len(vdops), 2)
        if deltas:
            summary['update_rate_avg_ms'] = round(sum(deltas) / len(deltas), 1)
            summary['update_rate_avg_hz'] = (
                round(1000.0 / (sum(deltas) / len(deltas)), 1)
                if sum(deltas) > 0 else 0
            )

    # Overall GPS health evaluation (Good vs Bad sentence and score)
    summary['verdict'] = evaluate_gps_quality(summary, gps_data, gpa_data)

    return summary


def evaluate_gps_quality(summary, gps_data, gpa_data):
    """
    Evaluate overall GPS quality throughout the flight log and return a verdict:
    rating: 'GOOD' | 'ACCEPTABLE' | 'BAD'
    score: 0-100
    sentence: A clear summary sentence stating whether GPS is good or bad and why.
    """
    if not summary or not gps_data:
        return {
            'rating': 'UNKNOWN',
            'score': 0,
            'sentence': 'No GPS data available to analyze.',
            'positives': [],
            'issues': [],
            'fix_drops': 0,
        }

    pct_3d = summary.get('pct_3d_or_better', 0)
    sats_avg = summary.get('sats_avg', 0)
    sats_min = summary.get('sats_min', 0)
    hdop_avg = summary.get('hdop_avg', 99)
    hdop_max = summary.get('hdop_max', 99)
    best_fix = summary.get('best_fix', 'No Fix')
    worst_fix = summary.get('worst_fix', 'No Fix')
    hacc_avg = summary.get('hacc_avg')

    # Detect fix drops (transition from status >= 3 to status < 3)
    fix_drops = 0
    in_3d = False
    for g in gps_data:
        is_3d = (g.get('status', 0) >= 3)
        if in_3d and not is_3d:
            fix_drops += 1
        in_3d = is_3d

    score = 100
    positives = []
    issues = []

    # 1. 3D fix availability
    if pct_3d >= 99.0:
        positives.append(f"continuous {best_fix} maintained for {pct_3d}% of the log")
    elif pct_3d >= 95.0:
        score -= 8
        positives.append(f"{best_fix} active for {pct_3d}% of flight")
    elif pct_3d >= 85.0:
        score -= 25
        issues.append(f"fix dropped below 3D for {(100 - pct_3d):.1f}% of the time")
    else:
        score -= 45
        issues.append(f"insufficient 3D fix coverage (only {pct_3d}% 3D lock, worst: {worst_fix})")

    # 2. Fix drops during flight
    if fix_drops > 0:
        score -= min(25, fix_drops * 10)
        issues.append(f"{fix_drops} mid-flight GPS fix drop{'s' if fix_drops > 1 else ''}")

    # 3. Satellites
    if sats_avg >= 14:
        positives.append(f"strong satellite coverage (avg {sats_avg}, min {sats_min})")
    elif sats_avg >= 10:
        if sats_min < 7:
            score -= 12
            issues.append(f"satellite count dipped to a low of {sats_min} (avg {sats_avg})")
        else:
            positives.append(f"adequate satellites (avg {sats_avg}, min {sats_min})")
    elif sats_avg >= 8:
        score -= 18
        issues.append(f"marginal satellite count (avg {sats_avg}, min {sats_min})")
    else:
        score -= 30
        issues.append(f"critically low satellite count (avg {sats_avg}, min {sats_min})")

    # 4. HDOP (Horizontal Dilution of Precision)
    if hdop_avg <= 0.9:
        positives.append(f"superb HDOP precision (avg {hdop_avg})")
    elif hdop_avg <= 1.4:
        positives.append(f"healthy HDOP (avg {hdop_avg})")
    elif hdop_avg <= 2.2:
        score -= 12
        issues.append(f"elevated HDOP (avg {hdop_avg}, max {hdop_max})")
    else:
        score -= 25
        issues.append(f"poor HDOP precision (avg {hdop_avg}, max {hdop_max})")

    # 5. Horizontal accuracy (if GPA present)
    if hacc_avg is not None:
        if hacc_avg <= 1.5:
            positives.append(f"tight horizontal accuracy ({hacc_avg}m avg)")
        elif hacc_avg > 3.5:
            score -= 10
            issues.append(f"loose horizontal accuracy ({hacc_avg}m avg)")

    score = max(5, min(100, score))

    # Determine Rating
    if score >= 85 and pct_3d >= 95 and sats_min >= 7 and hdop_avg <= 1.8 and fix_drops == 0:
        rating = 'GOOD'
    elif score >= 55 and pct_3d >= 75:
        rating = 'ACCEPTABLE'
    else:
        rating = 'BAD'

    # Build human-readable verdict sentence
    if rating == 'GOOD':
        pos_str = ', '.join(positives[:3]) if positives else f"{pct_3d}% 3D Fix, avg {sats_avg} satellites, and {hdop_avg} HDOP"
        sentence = f"Overall GPS Quality is GOOD (Score: {score}/100) — The GPS performed reliably throughout the log with {pos_str}, ensuring safe navigation."
    elif rating == 'ACCEPTABLE':
        iss_str = '; '.join(issues) if issues else f"minor HDOP or satellite fluctuations"
        sentence = f"Overall GPS Quality is ACCEPTABLE WITH WARNINGS (Score: {score}/100) — GPS maintained acceptable lock ({pct_3d}% ≥3D), but experienced {iss_str}. Flight is acceptable, but review antenna placement."
    else:
        iss_str = '; '.join(issues) if issues else f"poor fix lock ({pct_3d}%) and degraded satellite reception"
        sentence = f"Overall GPS Quality is BAD (Score: {score}/100) — Severe GPS degradation occurred throughout the log due to {iss_str}. Autonomous navigation and flight safety were compromised."

    return {
        'rating': rating,
        'score': score,
        'sentence': sentence,
        'positives': positives,
        'issues': issues,
        'fix_drops': fix_drops,
    }


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/analyze', methods=['POST'])
def analyze():
    if 'logfile' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    f = request.files['logfile']
    if not f.filename:
        return jsonify({'error': 'Empty filename'}), 400

    # Save to temp location
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ('.bin', '.log'):
        return jsonify({'error': 'Unsupported file type. Upload .bin or .log files.'}), 400

    filepath = os.path.join(UPLOAD_FOLDER, f.filename)
    f.save(filepath)

    try:
        result = parse_log(filepath)
        result['filename'] = f.filename
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': f'Failed to parse log: {str(e)}'}), 500
    finally:
        # Clean up uploaded file
        try:
            os.remove(filepath)
        except OSError:
            pass


@app.route('/api/analyze-batch', methods=['POST'])
def analyze_batch():
    files = request.files.getlist('logfiles')
    if not files:
        return jsonify({'error': 'No files uploaded'}), 400

    results = []
    errors = []

    for f in files:
        if not f.filename:
            continue

        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in ('.bin', '.log'):
            errors.append({
                'filename': f.filename,
                'error': 'Unsupported file type',
            })
            continue

        filepath = os.path.join(UPLOAD_FOLDER, f.filename)
        f.save(filepath)

        try:
            result = parse_log(filepath)
            result['filename'] = f.filename
            results.append(result)
        except Exception as e:
            traceback.print_exc()
            errors.append({
                'filename': f.filename,
                'error': str(e),
            })
        finally:
            try:
                os.remove(filepath)
            except OSError:
                pass

    if not results and errors:
        return jsonify({'error': 'All files failed to parse', 'errors': errors}), 400

    return jsonify({'files': results, 'errors': errors})


if __name__ == '__main__':
    print("\n" + "=" * 60)
    print("  ArduPilot GPS Log Analyzer")
    print("  Open http://localhost:5000 in your browser")
    print("=" * 60 + "\n")
    app.run(host='0.0.0.0', port=5000, debug=True)
