#!/usr/bin/env python3
"""
Rakhsha Crime Prediction ML Model
Uses XGBoost to predict crime risk scores (0-100) from historical data
Run: python3 scripts/train_model.py
"""

import os
import sys
import json
import pickle
import warnings
import argparse
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')

# ── Optional imports with graceful fallback ─────────────────
try:
    import xgboost as xgb
    HAS_XGBOOST = True
except ImportError:
    HAS_XGBOOST = False
    print("⚠️  XGBoost not installed. Using scikit-learn GradientBoosting as fallback.")
    print("    Install: pip install xgboost")

try:
    from sklearn.ensemble import GradientBoostingClassifier, RandomForestRegressor
    from sklearn.model_selection import train_test_split, cross_val_score
    from sklearn.preprocessing import StandardScaler
    from sklearn.metrics import mean_absolute_error, r2_score
    HAS_SKLEARN = True
except ImportError:
    print("❌ scikit-learn required: pip install scikit-learn pandas numpy")
    sys.exit(1)

try:
    import psycopg2
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False
    print("⚠️  psycopg2 not installed. Using synthetic data for training demo.")


# ── Feature Engineering ─────────────────────────────────────

def extract_features(df):
    """
    Extract ML features from crime records.
    Features: time-of-day, day-of-week, season, spatial density, crime type encoding.
    """
    df = df.copy()
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    df['hour'] = df['timestamp'].dt.hour
    df['day_of_week'] = df['timestamp'].dt.dayofweek
    df['month'] = df['timestamp'].dt.month
    df['is_night'] = ((df['hour'] >= 21) | (df['hour'] <= 5)).astype(int)
    df['is_weekend'] = (df['day_of_week'] >= 5).astype(int)
    df['is_monsoon'] = df['month'].isin([6, 7, 8, 9]).astype(int)

    # Encode crime type
    crime_types = ['harassment', 'theft', 'assault', 'robbery', 'vandalism', 'other']
    for ct in crime_types:
        df[f'crime_{ct}'] = (df.get('crime_type', '') == ct).astype(int)

    # Spatial binning (0.01 degree ≈ 1.1 km)
    df['lat_bin'] = (df['lat'] // 0.01) * 0.01
    df['lng_bin'] = (df['lng'] // 0.01) * 0.01

    # Normalized severity (0-1)
    df['severity_norm'] = df.get('severity', 3) / 10.0

    feature_cols = [
        'hour', 'day_of_week', 'month', 'is_night', 'is_weekend', 'is_monsoon',
        'lat_bin', 'lng_bin', 'severity_norm',
        'crime_harassment', 'crime_theft', 'crime_assault',
        'crime_robbery', 'crime_vandalism', 'crime_other',
    ]

    return df[feature_cols], feature_cols


def generate_synthetic_data(n_samples=5000):
    """Generate synthetic training data for demo purposes."""
    print(f"📊 Generating {n_samples} synthetic crime records...")
    np.random.seed(42)

    # Simulate Bhopal-area coordinates
    lat_center, lng_center = 23.2599, 77.4126
    lat_spread, lng_spread = 0.15, 0.15

    crime_types = ['harassment', 'theft', 'assault', 'robbery', 'vandalism', 'other']
    weights = [0.30, 0.28, 0.15, 0.12, 0.10, 0.05]

    data = {
        'lat': np.random.normal(lat_center, lat_spread, n_samples),
        'lng': np.random.normal(lng_center, lng_spread, n_samples),
        'crime_type': np.random.choice(crime_types, n_samples, p=weights),
        'severity': np.random.randint(1, 11, n_samples),
        'timestamp': [
            datetime.now() - timedelta(days=np.random.randint(0, 365), hours=np.random.randint(0, 24))
            for _ in range(n_samples)
        ],
    }

    df = pd.DataFrame(data)

    # Create target: risk score 0-100 with realistic patterns
    df['risk_score'] = (
        df['severity'] * 6                                              # severity weight
        + (df['timestamp'].apply(lambda t: t.hour >= 21 or t.hour <= 5)) * 20  # night penalty
        + (df['crime_type'] == 'assault') * 15                         # crime type penalty
        + (df['crime_type'] == 'robbery') * 12
        + (df['crime_type'] == 'harassment') * 8
        + np.random.normal(0, 5, n_samples)                            # noise
    ).clip(0, 100)

    return df


def fetch_data_from_db(database_url):
    """Fetch crime history from PostgreSQL."""
    print("🗄️  Fetching crime data from database...")
    conn = psycopg2.connect(database_url, sslmode='require')
    query = """
        SELECT
            ST_Y(location::geometry) AS lat,
            ST_X(location::geometry) AS lng,
            crime_type, severity, timestamp
        FROM crime_history
        WHERE timestamp > NOW() - INTERVAL '2 years'
        ORDER BY timestamp DESC
    """
    df = pd.read_sql(query, conn)
    conn.close()
    print(f"✅ Loaded {len(df)} crime records from DB")
    return df


# ── Model Training ──────────────────────────────────────────

def train_model(df, model_path='./scripts/crime_model.pkl'):
    print("\n🤖 Preparing features...")
    X, feature_cols = extract_features(df)
    y = df['risk_score'].values

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    if HAS_XGBOOST:
        print("🚀 Training XGBoost model...")
        model = xgb.XGBRegressor(
            n_estimators=200,
            max_depth=6,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_weight=3,
            gamma=0.1,
            reg_alpha=0.1,
            reg_lambda=1.0,
            random_state=42,
            n_jobs=-1,
            verbosity=0,
        )
    else:
        print("🌲 Training Gradient Boosting model (XGBoost fallback)...")
        from sklearn.ensemble import GradientBoostingRegressor
        model = GradientBoostingRegressor(
            n_estimators=150,
            max_depth=5,
            learning_rate=0.05,
            subsample=0.8,
            random_state=42,
        )

    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)

    print(f"\n📈 Model Performance:")
    print(f"   MAE  : {mae:.2f} risk points")
    print(f"   R²   : {r2:.4f}")

    # Feature importance
    if hasattr(model, 'feature_importances_'):
        importances = sorted(zip(feature_cols, model.feature_importances_), key=lambda x: -x[1])
        print(f"\n🔍 Top Feature Importances:")
        for feat, imp in importances[:8]:
            bar = '█' * int(imp * 50)
            print(f"   {feat:<25} {bar} {imp:.4f}")

    # Save model + metadata
    model_data = {
        'model': model,
        'feature_cols': feature_cols,
        'trained_at': datetime.now().isoformat(),
        'n_samples': len(df),
        'mae': mae,
        'r2': r2,
        'model_type': 'xgboost' if HAS_XGBOOST else 'gradient_boosting',
    }

    os.makedirs(os.path.dirname(model_path) or '.', exist_ok=True)
    with open(model_path, 'wb') as f:
        pickle.dump(model_data, f)

    print(f"\n✅ Model saved to: {model_path}")
    return model, feature_cols


# ── Prediction Server (Micro-service) ───────────────────────

def start_prediction_server(model_path, port=8001):
    """Simple HTTP server for model predictions."""
    try:
        from http.server import HTTPServer, BaseHTTPRequestHandler
        import pickle, json

        with open(model_path, 'rb') as f:
            model_data = pickle.load(f)

        model = model_data['model']
        feature_cols = model_data['feature_cols']

        class PredictHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != '/predict':
                    self.send_response(404); self.end_headers(); return

                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length))

                lat, lng = float(body['lat']), float(body['lng'])
                now = datetime.now()

                row = {
                    'lat': lat, 'lng': lng,
                    'crime_type': 'other', 'severity': 3,
                    'timestamp': now,
                }
                df = pd.DataFrame([row])
                X, _ = extract_features(df)
                X = X.reindex(columns=feature_cols, fill_value=0)

                score = float(model.predict(X)[0])
                score = max(0, min(100, score))
                color = 'green' if score <= 33 else ('yellow' if score <= 66 else 'red')

                response = json.dumps({'risk_score': round(score, 2), 'color_code': color}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, format, *args):
                pass  # Suppress request logs

        print(f"🌐 ML prediction server running on port {port}")
        HTTPServer(('0.0.0.0', port), PredictHandler).serve_forever()

    except Exception as e:
        print(f"❌ Server error: {e}")


# ── Main ────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Rakhsha Crime Prediction ML')
    parser.add_argument('--mode', choices=['train', 'serve', 'both'], default='train')
    parser.add_argument('--model-path', default='./scripts/crime_model.pkl')
    parser.add_argument('--port', type=int, default=8001)
    parser.add_argument('--db-url', default=os.getenv('DATABASE_URL'))
    args = parser.parse_args()

    if args.mode in ('train', 'both'):
        if args.db_url and HAS_PSYCOPG2:
            try:
                df = fetch_data_from_db(args.db_url)
            except Exception as e:
                print(f"⚠️  DB fetch failed ({e}), using synthetic data")
                df = generate_synthetic_data(10000)
        else:
            df = generate_synthetic_data(10000)

        train_model(df, args.model_path)

    if args.mode in ('serve', 'both'):
        start_prediction_server(args.model_path, args.port)
