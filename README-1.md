# 🌙 Bedtime Story Generator

A static webpage that generates a short, random bedtime story with a moral using Amazon Bedrock (Amazon Nova 2 Lite). Each click of **Tell me a story** picks a random character, setting and moral, then asks the model to write a calming story for children aged 4–8.

## Architecture

```
Browser ──► CloudFront ──► S3 (private bucket: index.html, app.js, style.css)
   │
   └──► API Gateway ──► Lambda ──► Amazon Bedrock (Nova 2 Lite, Converse API)
```

| Service | Role |
|---|---|
| Amazon S3 | Stores the static files. The bucket is private with Block Public Access on |
| Amazon CloudFront | Serves the site over HTTPS and reads S3 through Origin Access Control (OAC) |
| Amazon API Gateway | Public `GET` endpoint the page calls. Throttling caps cost |
| AWS Lambda | Builds a random prompt and calls Bedrock (see [Alternative: API Gateway only](#alternative-api-gateway-only)) |
| Amazon Bedrock | Generates the story with `global.amazon.nova-2-lite-v1:0` |

The browser never holds AWS credentials. All Bedrock calls happen on the server side.

## Project files

| File | Purpose |
|---|---|
| `index.html` | Page markup and Content Security Policy |
| `app.js` | Calls the API, parses title, story and moral, and renders them |
| `style.css` | Night-sky theme with accessible focus styles |

### Front-end details

- **Safe rendering:** model output is inserted with `textContent` only, never `innerHTML`, so HTML in a response is shown as text and never runs.
- **Content Security Policy:** the page only runs its own scripts and styles, and can only call `https://*.execute-api.us-east-1.amazonaws.com`.
- **Resilience:** the button is disabled while loading, requests time out after 32 seconds, and throttling (429), server errors and network or CORS failures each get a friendly message.
- **Accessibility:** status updates use `aria-live`, focus moves to the new story, and keyboard users see a visible focus ring.

## Prerequisites

- An AWS account with access to S3, CloudFront, API Gateway, Lambda, Bedrock and IAM
- Access to **Amazon Nova 2 Lite** enabled in the Bedrock console (region `us-east-1`)
- Optional: the AWS CLI for testing

## Setup

### 1. Enable the Bedrock model

1. Open the Bedrock console in `us-east-1` and enable access to **Amazon Nova 2 Lite**.
2. Nova 2 Lite only supports **inference profiles**, so call it as `global.amazon.nova-2-lite-v1:0`, not `amazon.nova-2-lite-v1:0`.

### 2. Create the Lambda function

1. Create a function named `bedtime-story-generator` with the Python 3.12+ runtime.
2. Set **Timeout** to 30 seconds (Configuration → General). The default of 3 seconds is too short.
3. Paste the code below into `lambda_function.py` and click **Deploy**.

```python
import json
import random
import boto3

bedrock = boto3.client("bedrock-runtime")
MODEL_ID = "global.amazon.nova-2-lite-v1:0"

CHARACTERS = ["a shy owl", "a curious fox", "a tiny dragon", "a brave turtle", "a sleepy bear cub"]
SETTINGS = ["an enchanted forest", "a cloud kingdom", "a quiet seaside village", "a moonlit meadow"]
MORALS = ["honesty", "kindness", "patience", "sharing", "courage", "gratitude"]

def lambda_handler(event, context):
    character = random.choice(CHARACTERS)
    setting = random.choice(SETTINGS)
    moral = random.choice(MORALS)

    prompt = (
        f"Write a gentle bedtime story for children aged 4-8 about {character} "
        f"in {setting}. The story should teach the value of {moral}. "
        "Keep it under 250 words, calming in tone, and end with a one-line moral "
        "starting with 'Moral:'. Give the story a title on the first line."
    )

    response = bedrock.converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 500, "temperature": 0.9},
    )
    story = response["output"]["message"]["content"][0]["text"]

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"story": story, "moral": moral}),
    }
```

### 3. Grant Bedrock permissions (least privilege)

Global inference profiles need **three** resources allowed. Add this policy to the Lambda execution role, replacing `us-east-1` and `123456789012` with your region and account ID:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InferenceProfileAccess",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.amazon.nova-2-lite-v1:0",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "us-east-1" } }
    },
    {
      "Sid": "InRegionModelAccess",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-lite-v1:0",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "us-east-1",
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.amazon.nova-2-lite-v1:0"
        }
      }
    },
    {
      "Sid": "GlobalModelAccess",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:::foundation-model/amazon.nova-2-lite-v1:0",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "unspecified",
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.amazon.nova-2-lite-v1:0"
        }
      }
    }
  ]
}
```

The region-less ARN and `"unspecified"` region in the third statement are intentional. They're what allow global routing. See [Global cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html).

Test with the Lambda console's **Test** button using an empty `{}` event. A working call takes a few seconds and returns a story in `body`.

### 4. Create the API

1. In API Gateway, create an **HTTP API** with route `GET /bedtime-story` integrated with the Lambda function.
2. Under **Stages**, set throttling, e.g. rate `5` and burst `10`.
3. Put the invoke URL in `app.js`:

   ```js
   const API_URL = "https://YOUR-API-ID.execute-api.us-east-1.amazonaws.com/bedtime-story";
   ```

If your API is not in `us-east-1`, also update `connect-src` in the CSP in `index.html`.

### 5. Host the site on S3 and CloudFront

1. **S3:** create a bucket in `us-east-1` and leave **Block all public access** on. Don't enable static website hosting. Upload `index.html`, `app.js` and `style.css` to the bucket root.
2. **CloudFront:** create a distribution with:
   - **Origin:** your bucket's REST endpoint (`<bucket>.s3.us-east-1.amazonaws.com`)
   - **Origin access:** Origin access control (OAC)
   - **Viewer protocol policy:** Redirect HTTP to HTTPS
   - **Allowed methods:** GET, HEAD
   - **Default root object:** `index.html`
3. **Bucket policy:** apply the policy CloudFront generates. It's scoped to your distribution:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "AllowCloudFrontServicePrincipal",
       "Effect": "Allow",
       "Principal": { "Service": "cloudfront.amazonaws.com" },
       "Action": "s3:GetObject",
       "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*",
       "Condition": {
         "StringEquals": {
           "AWS:SourceArn": "arn:aws:cloudfront::YOUR-ACCOUNT-ID:distribution/YOUR-DISTRIBUTION-ID"
         }
       }
     }]
   }
   ```

### 6. Configure CORS

In API Gateway, open **CORS** and set:

- **Allow-Origin:** `https://YOUR-ID.cloudfront.net` (no trailing slash, don't use `*`)
- **Allow-Methods:** `GET`
- **Allow-Headers:** `content-type`

## Testing

```bash
# API returns a story
curl https://YOUR-API-ID.execute-api.us-east-1.amazonaws.com/bedtime-story

# Site is served by CloudFront (expect 200)
curl -s -o /dev/null -w "%{http_code}\n" https://YOUR-ID.cloudfront.net/

# Bucket is NOT publicly readable (expect 403)
curl -s -o /dev/null -w "%{http_code}\n" https://YOUR-BUCKET-NAME.s3.us-east-1.amazonaws.com/index.html
```

Open the CloudFront URL and click **Tell me a story** a few times. Each click should give a different story.

## Updating the site

After editing any front-end file:

1. Re-upload the file to S3.
2. In CloudFront, open **Invalidations**, create one and enter `/*`.

