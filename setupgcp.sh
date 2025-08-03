#!/bin/bash

# ====== Configurable Settings ======
PROJECT_ID="neonbinder"
SERVICE_NAME="puppeteer-automation"
REGION="us-central1"
SERVICE_ACCOUNT_NAME="neonbinder-browser-runner"
IMAGE_DIR="." # or replace with --image=... if building from container

# ====== Derived Values ======
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "⏳ Setting project..."
gcloud config set project "$PROJECT_ID"

echo "🛠️  Creating service account: $SERVICE_ACCOUNT_NAME..."
# Check if service account already exists, create if it doesn't
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
      --project="$PROJECT_ID" \
      --display-name="Neon Binder Browser Automation Runner"
    echo "✅ Service account created successfully"
else
    echo "ℹ️  Service account already exists, skipping creation"
fi

echo "🔐 Granting Secret Manager access..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet

echo "📜 Granting Log Writer access..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/logging.logWriter" \
  --quiet

echo "🔗 Granting Cloud Run Invoker access..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/run.invoker" \
  --quiet

# echo "🚀 Deploying to Cloud Run..."
# gcloud run deploy "$SERVICE_NAME" \
#   --source="$IMAGE_DIR" \
#   --region="$REGION" \
#   --project="$PROJECT_ID" \
#   --service-account="$SERVICE_ACCOUNT_EMAIL" \
#   --allow-unauthenticated \
#   --memory=1Gi \
#   --timeout=300

echo "✅ Setup complete! Script is idempotent and can be run multiple times safely."