# BlueDart Lambda — Complete API Reference

> A single AWS Lambda function (`index.mjs`) that wraps the BlueDart courier API. Your NestJS backend invokes it via the AWS SDK — credentials never leave the Lambda environment.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Environment Variables](#environment-variables)
3. [Deployment (`deploy.sh`)](#deployment-deploysh)
4. [Request & Response Shape](#request--response-shape)
5. [Actions Reference](#actions-reference)
   - [generate_waybill](#generate_waybill)
   - [get_token](#get_token)
   - [cancel_waybill](#cancel_waybill)
   - [update_ewaybill](#update_ewaybill)
   - [register_pickup](#register_pickup)
   - [cancel_pickup](#cancel_pickup)
   - [track_shipment](#track_shipment)
   - [get_transit_time](#get_transit_time)
   - [get_services_for_pincode](#get_services_for_pincode)
6. [NestJS Integration](#nestjs-integration)
7. [Manual AWB & Pickup Workflow](#manual-awb--pickup-workflow)
8. [Passing Extra Fields](#passing-extra-fields)
9. [Secrets Management](#secrets-management)
10. [Security Summary](#security-summary)

---

## Architecture Overview

```
NestJS Backend
     │
     │  AWS SDK (InvokeCommand)
     ▼
AWS Lambda  ──► BlueDart API
(index.mjs)
     │
     ▼  (when generateAwb: true)
AWS S3 Bucket
(AWB PDF stored at orders/{orderId}/awb-{orderId}.pdf)
```

- The Lambda is the **only** service that holds BlueDart credentials.
- Your NestJS app only needs IAM permission to **invoke** the Lambda — never the BlueDart keys themselves.
- AWB PDFs are stored in a locked S3 bucket defined by environment variables; the payload cannot override the target bucket.

---

## Environment Variables

Set these on the Lambda function. All are required.

| Variable | Description |
|---|---|
| `BLUEDART_LOGIN_ID` | Your BlueDart account login ID |
| `BLUEDART_LICENCE_KEY` | BlueDart licence key (used for waybill/pickup APIs) |
| `BLUEDART_TRACKING_LICENCE_KEY` | Separate licence key used for tracking calls |
| `BLUEDART_CLIENT_ID` | OAuth client ID (used to fetch JWT tokens) |
| `BLUEDART_CLIENT_SECRET` | OAuth client secret |
| `BLUEDART_ENV` | `production` or `staging` |
| `BLUEDART_API_TYPE` | API type identifier as specified by BlueDart |
| `AWB_S3_BUCKET` | S3 bucket name where AWB PDFs are uploaded |
| `AWB_S3_REGION` | AWS region of the S3 bucket (e.g. `ap-south-1`) |

**Optional — for secrets managers:**

| Variable | Description |
|---|---|
| `BLUEDART_SECRET_NAME` | AWS Secrets Manager secret name (if using Option B) |
| `BLUEDART_SSM_PATH` | SSM Parameter Store path (if using Option C) |

---

## Deployment (`deploy.sh`)

The `deploy.sh` script reads variables from a `.env` file and handles both **first-time creation** and **updates** of the Lambda.

### Prerequisites

- AWS CLI installed and configured (`aws configure`)
- A `.env` file in the same directory as `deploy.sh` and `index.mjs`

### `.env` file format

```dotenv
BLUEDART_LOGIN_ID=your_login_id
BLUEDART_LICENCE_KEY=your_licence_key
BLUEDART_TRACKING_LICENCE_KEY=your_tracking_key
BLUEDART_CLIENT_ID=your_client_id
BLUEDART_CLIENT_SECRET=your_client_secret
BLUEDART_ENV=production
BLUEDART_API_TYPE=your_api_type
AWB_S3_BUCKET=your-s3-bucket-name
AWB_S3_REGION=ap-south-1

# Required only for first-time creation
LAMBDA_ROLE_ARN=arn:aws:iam::123456789012:role/your-lambda-role
```

### How the script works

**Step 1 — Load `.env`**

All variables are exported into the shell environment. The script exits with an error if `.env` is not found.

**Step 2 — Zip `index.mjs`**

```bash
zip bluedart-lambda.zip index.mjs
```

**Step 3 — Check if Lambda exists**

```bash
aws lambda get-function --function-name bluedart-lambda
```

**If the function already exists → Update:**

```bash
# Updates the code
aws lambda update-function-code \
  --function-name bluedart-lambda \
  --zip-file fileb://bluedart-lambda.zip

# Updates environment variables
aws lambda update-function-configuration \
  --function-name bluedart-lambda \
  --environment "Variables={...}"
```

**If the function does not exist → Create:**

Requires `LAMBDA_ROLE_ARN` to be set in `.env`. Creates the function with:
- Runtime: `nodejs20.x`
- Handler: `index.handler`
- Timeout: `30` seconds
- All environment variables from `.env`

```bash
aws lambda create-function \
  --function-name bluedart-lambda \
  --runtime nodejs20.x \
  --role $LAMBDA_ROLE_ARN \
  --handler index.handler \
  --zip-file fileb://bluedart-lambda.zip \
  --timeout 30 \
  --environment "Variables={...}"
```

**Step 4 — Cleanup**

The temporary `.zip` file is deleted after deployment.

### Running the script

```bash
chmod +x deploy.sh
./deploy.sh
```

Expected output:

```
📦 Zipping index.mjs...
🆙 Updating existing function: bluedart-lambda...
⚙️  Updating environment variables...
✅ Deployment complete!
```

---

## Request & Response Shape

Every Lambda invocation uses the same envelope.

### Request

```json
{
  "action": "<ACTION_NAME>",
  "payload": { }
}
```

### Success Response

```json
{
  "success": true,
  "action": "<ACTION_NAME>",
  "data": { }
}
```

### Error Response

```json
{
  "success": false,
  "action": "<ACTION_NAME>",
  "error": "Human-readable error message"
}
```

---

## Actions Reference

---

### `generate_waybill`

Generates a BlueDart waybill (AWB number) for a shipment. Optionally uploads an AWB PDF to S3.

#### Request

```json
{
  "action": "generate_waybill",
  "payload": {
    "consignee": {
      "name": "Rahul Sharma",
      "address1": "12 MG Road",
      "pincode": "560001",
      "mobile": "9876543210",
      "city": "Bengaluru",
      "stateCode": "KA"
    },
    "shipper": {
      "customerCode": "099960",
      "originArea": "BOM",
      "pincode": "400001",
      "name": "My Store"
    },
    "services": {
      "productCode": "A",
      "actualWeight": 1.5,
      "pieceCount": 1,
      "declaredValue": 999,
      "creditReferenceNo": "ORD-20240001"
    },
    "generateAwb": true,
    "orderId": "ORD-12345"
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `consignee.name` | string | ✅ | Recipient full name |
| `consignee.address1` | string | ✅ | Delivery address line 1 |
| `consignee.pincode` | string | ✅ | Delivery pincode |
| `consignee.mobile` | string | ✅ | Recipient mobile number |
| `consignee.city` | string | ✅ | Delivery city |
| `consignee.stateCode` | string | ✅ | Two-letter state code (e.g. `KA`, `MH`) |
| `shipper.customerCode` | string | ✅ | Your BlueDart customer code |
| `shipper.originArea` | string | ✅ | Origin area code (e.g. `BOM`, `DEL`) |
| `shipper.pincode` | string | ✅ | Pickup pincode |
| `shipper.name` | string | ✅ | Shipper/store name |
| `services.productCode` | string | ✅ | BlueDart product code (e.g. `A` for Express) |
| `services.actualWeight` | number | ✅ | Shipment weight in kg |
| `services.pieceCount` | number | ✅ | Number of pieces |
| `services.declaredValue` | number | ✅ | Declared shipment value in INR |
| `services.creditReferenceNo` | string | ✅ | Your internal order/reference number |
| `generateAwb` | boolean | ❌ | Set `true` to generate a PDF and upload it to S3 |
| `orderId` | string | ❌ | Used to build the S3 path: `orders/{orderId}/awb-{orderId}.pdf` |

> **Note:** The S3 bucket and region are locked to environment variables. They cannot be overridden via the payload. The Lambda validates bucket access before attempting the upload.

#### Success Response

```json
{
  "success": true,
  "action": "generate_waybill",
  "data": {
    "AWBNo": "89186876974",
    "awbPdfUrl": "https://s3.ap-south-1.amazonaws.com/your-bucket/orders/ORD-12345/awb-ORD-12345.pdf"
  }
}
```

---

### `get_token`

Fetches a fresh JWT token from BlueDart using your OAuth client credentials.

#### Request

```json
{
  "action": "get_token"
}
```

#### Success Response

```json
{
  "success": true,
  "action": "get_token",
  "data": {
    "access_token": "eyJhbGciOiJSUzI1NiIsInR5...",
    "token_type": "Bearer",
    "expires_in": 3600
  }
}
```

---

### `cancel_waybill`

Cancels a previously generated waybill by AWB number.

#### Request

```json
{
  "action": "cancel_waybill",
  "payload": {
    "awbNo": "89186876973"
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `awbNo` | string | ✅ | The AWB number to cancel |

#### Success Response

```json
{
  "success": true,
  "action": "cancel_waybill",
  "data": {
    "Status": "Cancelled"
  }
}
```

---

### `update_ewaybill`

Links a government e-waybill number to an existing BlueDart waybill.

#### Request

```json
{
  "action": "update_ewaybill",
  "payload": {
    "waybillNumber": "20470326332",
    "eWaybillNumber": "125478547851",
    "eWaybillDate": 1684748434000,
    "invoiceNumber": "INV-001",
    "invoiceDate": 1684748434000,
    "sellerGSTNo": "09565720209C"
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `waybillNumber` | string | ✅ | BlueDart AWB number |
| `eWaybillNumber` | string | ✅ | Government e-waybill number |
| `eWaybillDate` | number | ✅ | E-waybill generation date (Unix ms timestamp) |
| `invoiceNumber` | string | ✅ | Invoice number for the shipment |
| `invoiceDate` | number | ✅ | Invoice date (Unix ms timestamp) |
| `sellerGSTNo` | string | ✅ | Seller's GST registration number |

#### Success Response

```json
{
  "success": true,
  "action": "update_ewaybill",
  "data": {
    "Status": "Updated"
  }
}
```

---

### `register_pickup`

Schedules a pickup request for one or more shipments.

#### Request

```json
{
  "action": "register_pickup",
  "payload": {
    "customerCode": "099960",
    "customerName": "My Store",
    "address1": "Warehouse Block A",
    "pincode": "400001",
    "areaCode": "BOM",
    "contactPersonName": "Priya Nair",
    "mobile": "9123456789",
    "productCode": "A",
    "subProducts": ["E-Tailing"],
    "pickupDate": 1716700000000,
    "pickupTime": "1600",
    "officeCloseTime": "1800",
    "numberOfPieces": 3,
    "weight": 2.5,
    "volumeWeight": 2.5
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `customerCode` | string | ✅ | Your BlueDart customer code |
| `customerName` | string | ✅ | Business/store name |
| `address1` | string | ✅ | Pickup address |
| `pincode` | string | ✅ | Pickup pincode |
| `areaCode` | string | ✅ | BlueDart area code (e.g. `BOM`) |
| `contactPersonName` | string | ✅ | Name of person available at pickup |
| `mobile` | string | ✅ | Contact mobile number |
| `productCode` | string | ✅ | BlueDart product code |
| `subProducts` | string[] | ✅ | Sub-product list (e.g. `["E-Tailing"]`) |
| `pickupDate` | number | ✅ | Requested pickup date (Unix ms timestamp) |
| `pickupTime` | string | ✅ | Requested pickup time in `HHMM` format (e.g. `"1600"`) |
| `officeCloseTime` | string | ✅ | Office close time in `HHMM` format (e.g. `"1800"`) |
| `numberOfPieces` | number | ✅ | Total number of pieces to be picked up |
| `weight` | number | ✅ | Total weight in kg |
| `volumeWeight` | number | ✅ | Volumetric weight in kg |

#### Success Response

```json
{
  "success": true,
  "action": "register_pickup",
  "data": {
    "TokenNumber": 748984,
    "Status": "Registered"
  }
}
```

> **Note:** Save the `TokenNumber` from the response. You will need it to cancel the pickup.

---

### `cancel_pickup`

Cancels a previously registered pickup request.

#### Request

```json
{
  "action": "cancel_pickup",
  "payload": {
    "tokenNumber": 748984,
    "pickupDate": 1716700000000,
    "remarks": "Customer cancelled order"
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `tokenNumber` | number | ✅ | Token number received from `register_pickup` |
| `pickupDate` | number | ✅ | The original pickup date (Unix ms timestamp) |
| `remarks` | string | ❌ | Reason for cancellation |

#### Success Response

```json
{
  "success": true,
  "action": "cancel_pickup",
  "data": {
    "Status": "Cancelled"
  }
}
```

---

### `track_shipment`

Tracks a shipment by AWB number or credit reference number.

#### Request — track by AWB number

```json
{
  "action": "track_shipment",
  "payload": {
    "awbNumber": "76662235090",
    "parseXml": true
  }
}
```

#### Request — track by reference number

```json
{
  "action": "track_shipment",
  "payload": {
    "referenceNumber": "ORD-20240001",
    "parseXml": true
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `awbNumber` | string | ✅* | BlueDart AWB number. *Omit if using `referenceNumber` |
| `referenceNumber` | string | ✅* | Your order/credit reference number. *Omit if using `awbNumber` |
| `parseXml` | boolean | ❌ | Set `true` (recommended) to receive a clean JS object instead of raw XML |

#### Success Response

```json
{
  "success": true,
  "action": "track_shipment",
  "data": {
    "AWBNo": "76662235090",
    "Status": "Delivered",
    "DeliveryDate": "2024-05-20",
    "Scans": [
      {
        "ScanDetail": {
          "Scan": "Delivered",
          "ScanDate": "2024-05-20",
          "ScanTime": "14:32",
          "ScannedLocation": "Bengaluru Hub"
        }
      }
    ]
  }
}
```

---

### `get_transit_time`

Estimates the delivery date/time between two pincodes for a given product and pickup schedule.

#### Request

```json
{
  "action": "get_transit_time",
  "payload": {
    "fromPincode": "400012",
    "toPincode": "560001",
    "productCode": "A",
    "subProductCode": "P",
    "pickupDate": 1716700000000,
    "pickupTime": "16:00"
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `fromPincode` | string | ✅ | Origin pincode |
| `toPincode` | string | ✅ | Destination pincode |
| `productCode` | string | ✅ | BlueDart product code (e.g. `A`) |
| `subProductCode` | string | ✅ | Sub-product code (e.g. `P`) |
| `pickupDate` | number | ✅ | Planned pickup date (Unix ms timestamp) |
| `pickupTime` | string | ✅ | Planned pickup time in `HH:MM` format |

#### Success Response

```json
{
  "success": true,
  "action": "get_transit_time",
  "data": {
    "ExpectedDeliveryDate": "2024-05-22",
    "TransitDays": 2
  }
}
```

---

### `get_services_for_pincode`

Returns available BlueDart services and serviceability details for a given pincode.

#### Request

```json
{
  "action": "get_services_for_pincode",
  "payload": {
    "pincode": "560001"
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `pincode` | string | ✅ | Pincode to check serviceability for |

#### Success Response

```json
{
  "success": true,
  "action": "get_services_for_pincode",
  "data": {
    "OriginArea": "BLR",
    "Pincode": "560001",
    "City": "Bengaluru",
    "Products": [
      {
        "ProductCode": "A",
        "ProductDesc": "BlueDart Express"
      }
    ]
  }
}
```

---

## NestJS Integration

Install the AWS SDK:

```bash
npm install @aws-sdk/client-lambda
```

Create `bluedart.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from '@aws-sdk/client-lambda';

@Injectable()
export class BlueDartService {
  private readonly lambda = new LambdaClient({
    region: process.env.AWS_REGION || 'ap-south-1',
  });
  private readonly functionName =
    process.env.BLUEDART_LAMBDA_NAME || 'bluedart-lambda';
  private readonly log = new Logger(BlueDartService.name);

  private async invoke<T = any>(action: string, payload: object): Promise<T> {
    const command = new InvokeCommand({
      FunctionName: this.functionName,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify({ action, payload })),
    });

    const response = await this.lambda.send(command);
    const result = JSON.parse(Buffer.from(response.Payload!).toString());

    if (!result.success) {
      this.log.error(`BlueDart action "${action}" failed: ${result.error}`);
      throw new Error(result.error);
    }

    return result.data;
  }

  generateWaybill(payload: object)   { return this.invoke('generate_waybill', payload); }
  generateAwb(payload: object)       { return this.invoke('generate_waybill', { ...payload, generateAwb: true }); }
  cancelWaybill(awbNo: string)       { return this.invoke('cancel_waybill', { awbNo }); }
  updateEwaybill(payload: object)    { return this.invoke('update_ewaybill', payload); }
  registerPickup(payload: object)    { return this.invoke('register_pickup', payload); }
  cancelPickup(tokenNumber: number, pickupDate: number) {
    return this.invoke('cancel_pickup', { tokenNumber, pickupDate });
  }
  trackShipment(awbNumber: string, parseXml = true) {
    return this.invoke('track_shipment', { awbNumber, parseXml });
  }
  getTransitTime(from: string, to: string, pickupDate: number) {
    return this.invoke('get_transit_time', {
      fromPincode: from,
      toPincode: to,
      pickupDate,
      productCode: 'A',
    });
  }
  getServicesForPincode(pincode: string) {
    return this.invoke('get_services_for_pincode', { pincode });
  }
  getToken() { return this.invoke('get_token', {}); }
}
```

Register in `app.module.ts`:

```typescript
import { BlueDartService } from './bluedart/bluedart.service';

@Module({
  providers: [BlueDartService],
  exports: [BlueDartService],
})
export class AppModule {}
```

---

## Manual AWB & Pickup Workflow

For order management UIs where admins trigger shipping manually:

### Step 1 — Generate AWB

```typescript
@Post(':orderId/generate-awb')
async handleGenerateAwb(@Param('orderId') orderId: string) {
  const order = await this.ordersService.findOne(orderId);

  const result = await this.blueDartService.generateAwb({
    consignee: {
      name: order.customerName,
      address1: order.deliveryAddress,
      pincode: order.deliveryPincode,
      mobile: order.customerMobile,
      city: order.deliveryCity,
      stateCode: order.deliveryStateCode,
    },
    shipper: {
      customerCode: process.env.BLUEDART_CUSTOMER_CODE,
      originArea: process.env.BLUEDART_ORIGIN_AREA,
      pincode: process.env.WAREHOUSE_PINCODE,
      name: 'My Store',
    },
    services: {
      productCode: 'A',
      actualWeight: order.weight,
      pieceCount: order.pieceCount,
      declaredValue: order.totalAmount,
      creditReferenceNo: orderId,
    },
    orderId,
  });

  // Persist AWB number and PDF URL
  await this.ordersService.update(orderId, {
    awbNumber: result.AWBNo,
    awbPdfUrl: result.awbPdfUrl,
  });

  return result;
}
```

### Step 2 — Register Pickup

```typescript
@Post(':orderId/register-pickup')
async handleRegisterPickup(@Param('orderId') orderId: string) {
  const order = await this.ordersService.findOne(orderId);

  if (!order.awbNumber) {
    throw new Error('AWB must be generated before registering pickup.');
  }

  const result = await this.blueDartService.registerPickup({
    customerCode: process.env.BLUEDART_CUSTOMER_CODE,
    customerName: 'My Store',
    address1: 'Warehouse Block A',
    pincode: process.env.WAREHOUSE_PINCODE,
    areaCode: process.env.BLUEDART_ORIGIN_AREA,
    contactPersonName: 'Warehouse Manager',
    mobile: process.env.WAREHOUSE_MOBILE,
    productCode: 'A',
    subProducts: ['E-Tailing'],
    pickupDate: Date.now(),
    pickupTime: '1600',
    officeCloseTime: '1800',
    numberOfPieces: order.pieceCount,
    weight: order.weight,
    volumeWeight: order.volumeWeight,
  });

  await this.ordersService.update(orderId, {
    pickupTokenNumber: result.TokenNumber,
  });

  return result;
}
```

---

## Passing Extra Fields

Each payload section supports an `_extra` key for any BlueDart fields that are not explicitly mapped by the Lambda. This keeps the core payload clean while still allowing full API coverage.

```json
{
  "action": "generate_waybill",
  "payload": {
    "consignee": { "name": "...", "_extra": { "Address2": "Near Metro Station" } },
    "shipper": { "customerCode": "099960" },
    "services": {
      "productCode": "A",
      "actualWeight": 1.5,
      "_extra": {
        "OTPBasedDelivery": "1",
        "IsCommercialShipment": true,
        "CommodityDetail1": "Electronics"
      }
    }
  }
}
```

---

## Secrets Management

Three options for storing BlueDart credentials. All are more secure than hardcoding.

### Option A — Lambda Environment Variables (Default)

Direct env vars on the Lambda function. Set during deployment via `deploy.sh`.

**Best for:** Most projects.

### Option B — AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name bluedart/credentials \
  --secret-string '{
    "BLUEDART_LOGIN_ID":"...",
    "BLUEDART_LICENCE_KEY":"...",
    "BLUEDART_CLIENT_ID":"...",
    "BLUEDART_CLIENT_SECRET":"..."
  }'
```

Set `BLUEDART_SECRET_NAME=bluedart/credentials` on the Lambda. Ensure the Lambda IAM role has `secretsmanager:GetSecretValue` permission.

**Cost:** $0.40/secret/month + $0.05 per 10,000 API calls.  
**Best for:** Production / regulated environments.

### Option C — SSM Parameter Store (Free)

```bash
aws ssm put-parameter \
  --name "/bluedart/credentials" \
  --value '{"BLUEDART_LOGIN_ID":"...","BLUEDART_LICENCE_KEY":"..."}' \
  --type "SecureString"
```

Set `BLUEDART_SSM_PATH=/bluedart/credentials` on the Lambda. Ensure the Lambda IAM role has `ssm:GetParameter` permission.

**Cost:** Free (within standard limits).  
**Best for:** Projects wanting free secret management.

---

## Security Summary

| Option | Security Level | Cost | Recommended For |
|---|---|---|---|
| Lambda environment variables | ✅ Good | Free | Most projects |
| AWS Secrets Manager | ✅✅ Best | ~$0.40/mo | Production / regulated |
| AWS SSM Parameter Store | ✅✅ Best | Free | Production (cost-sensitive) |
| Keys passed via HTTP from NestJS | ❌ Never | — | Never |
| Keys hardcoded in Lambda source | ❌ Never | — | Never |

> Your NestJS service only needs IAM permission to **invoke** the Lambda. It never handles or stores BlueDart credentials.