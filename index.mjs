import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * BlueDart / DHL eCommerce India — AWS Lambda Function
 *
 * ─── HOW TO CALL THIS LAMBDA ────────────────────────────────────────────────
 *  Invoke via API Gateway (HTTP) or AWS SDK with a JSON body:
 *
 *  {
 *    "action": "<ACTION_NAME>",
 *    "payload": { ...action-specific fields... }
 *  }
 *
 *  Every response follows:
 *  {
 *    "success": true | false,
 *    "action": "<ACTION_NAME>",
 *    "data":   <BlueDart API response>,   // on success
 *    "error":  "<message>"               // on failure
 *  }
 *
 * ─── SUPPORTED ACTIONS ──────────────────────────────────────────────────────
 *  generate_waybill        Generate a new AWB / Waybill
 *  cancel_waybill          Cancel an existing AWB
 *  update_ewaybill         Attach / update e-Waybill details on an AWB
 *  register_pickup         Schedule a pickup
 *  cancel_pickup           Cancel a scheduled pickup
 *  track_shipment          Track by AWB or reference number
 *  get_transit_time        Estimated delivery time between two pincodes
 *  get_services_for_pincode  Check serviceability & value limits for a pincode
 *
 * ─── ENVIRONMENT VARIABLES (set in Lambda → Configuration → Environment) ───
 *  BLUEDART_LOGIN_ID      Your BlueDart API Login ID
 *  BLUEDART_LICENCE_KEY   Your BlueDart Licence Key
 *  BLUEDART_API_TYPE      "S" for production, "T" for sandbox (default: "S")
 *  BLUEDART_JWT_TOKEN     Your JWT Token for the Authorization header
 *
 * ─── SECURITY NOTE ──────────────────────────────────────────────────────────
 *  All credentials live ONLY in Lambda Environment Variables.
 *  • Never commit keys to source code.
 *  • Rotate BLUEDART_JWT_TOKEN periodically (BlueDart tokens expire).
 *  • For tighter security, store keys in AWS Secrets Manager and fetch them
 *    at cold-start (see getSecrets() stub below).
 *  • Restrict this Lambda's API Gateway with an API key or Cognito authorizer
 *    so only your NestJS backend (or trusted apps) can invoke it.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ── Base URLs ─────────────────────────────────────────────────────────────────
const BASE_URLS = {
  production: 'https://apigateway.bluedart.com/in/transportation',
  sandbox: 'https://apigateway-sandbox.bluedart.com/in/transportation',
};

let cachedSecrets = null;
let cachedJwtToken = null;

// ── Credentials (resolved once per cold-start) ────────────────────────────────
async function getCredentials() {
  const secretName = process.env.BLUEDART_SECRET_NAME;
  const ssmPath = process.env.BLUEDART_SSM_PATH;

  if (secretName && !cachedSecrets) {
    try {
      const sm = new SecretsManagerClient({
        region: process.env.AWS_REGION || 'ap-south-1',
      });
      const response = await sm.send(
        new GetSecretValueCommand({ SecretId: secretName }),
      );
      cachedSecrets = JSON.parse(response.SecretString);
    } catch (err) {
      console.error(
        'Failed to fetch secrets from Secrets Manager:',
        err.message,
      );
    }
  } else if (ssmPath && !cachedSecrets) {
    try {
      const ssm = new SSMClient({
        region: process.env.AWS_REGION || 'ap-south-1',
      });
      const response = await ssm.send(
        new GetParameterCommand({ Name: ssmPath, WithDecryption: true }),
      );
      cachedSecrets = JSON.parse(response.Parameter.Value);
    } catch (err) {
      console.error(
        'Failed to fetch secrets from SSM Parameter Store:',
        err.message,
      );
    }
  }

  const secrets = cachedSecrets || {};

  const loginID = secrets.BLUEDART_LOGIN_ID || process.env.BLUEDART_LOGIN_ID;
  const licenceKey =
    secrets.BLUEDART_LICENCE_KEY || process.env.BLUEDART_LICENCE_KEY;
  const trackingKey =
    secrets.BLUEDART_TRACKING_LICENCE_KEY ||
    process.env.BLUEDART_TRACKING_LICENCE_KEY ||
    licenceKey;
  const clientID = secrets.BLUEDART_CLIENT_ID || process.env.BLUEDART_CLIENT_ID;
  const clientSecret =
    secrets.BLUEDART_CLIENT_SECRET || process.env.BLUEDART_CLIENT_SECRET;
  const apiType =
    secrets.BLUEDART_API_TYPE || process.env.BLUEDART_API_TYPE || 'S';
  const jwtToken = cachedJwtToken || secrets.BLUEDART_JWT_TOKEN || process.env.BLUEDART_JWT_TOKEN;
  const env = secrets.BLUEDART_ENV || process.env.BLUEDART_ENV || 'production';

  const s3Bucket = secrets.AWB_S3_BUCKET || process.env.AWB_S3_BUCKET;
  const s3Region =
    secrets.AWB_S3_REGION || process.env.AWB_S3_REGION || 'ap-south-1';

  const customerCode =
    secrets.BLUEDART_CUSTOMER_CODE || process.env.BLUEDART_CUSTOMER_CODE;
  const originArea =
    secrets.BLUEDART_ORIGIN_AREA || process.env.BLUEDART_ORIGIN_AREA;
  const shipperName =
    secrets.BLUEDART_SHIPPER_NAME ||
    process.env.BLUEDART_SHIPPER_NAME ||
    'VYBN';
  const shipperAddress1 =
    secrets.BLUEDART_SHIPPER_ADDRESS1 ||
    process.env.BLUEDART_SHIPPER_ADDRESS1 ||
    '';
  const shipperAddress2 =
    secrets.BLUEDART_SHIPPER_ADDRESS2 ||
    process.env.BLUEDART_SHIPPER_ADDRESS2 ||
    '';
  const shipperAddress3 =
    secrets.BLUEDART_SHIPPER_ADDRESS3 ||
    process.env.BLUEDART_SHIPPER_ADDRESS3 ||
    '';
  const shipperPincode =
    secrets.BLUEDART_SHIPPER_PINCODE ||
    process.env.BLUEDART_SHIPPER_PINCODE ||
    '';
  const shipperMobile =
    secrets.BLUEDART_SHIPPER_MOBILE ||
    process.env.BLUEDART_SHIPPER_MOBILE ||
    '';
  const shipperEmail =
    secrets.BLUEDART_SHIPPER_EMAIL || process.env.BLUEDART_SHIPPER_EMAIL || '';

  if (!loginID || !licenceKey) {
    throw new Error(
      'Missing required credentials. Set them in environment variables or AWS Secrets Manager.',
    );
  }

  return {
    profile: { LoginID: loginID, LicenceKey: licenceKey, Api_type: apiType },
    Profile: { LoginID: loginID, LicenceKey: licenceKey, Api_type: apiType },
    trackingProfile: {
      LoginID: loginID,
      LicenceKey: trackingKey,
      Api_type: apiType,
    },
    jwtToken,
    clientID,
    clientSecret,
    baseUrl: BASE_URLS[env] || BASE_URLS.production,
    s3: { bucket: s3Bucket, region: s3Region },
    shipperDefaults: {
      customerCode,
      originArea,
      name: shipperName,
      address1: shipperAddress1,
      address2: shipperAddress2,
      address3: shipperAddress3,
      pincode: shipperPincode,
      mobile: shipperMobile,
      email: shipperEmail,
    },
    env,
  };
}

/**
 * getToken
 * Fetches a new JWT token using ClientID and clientSecret.
 */
async function getToken(creds) {
  if (!creds.clientID || !creds.clientSecret) {
    throw new Error(
      'Missing BLUEDART_CLIENT_ID or BLUEDART_CLIENT_SECRET for login',
    );
  }

  const url = `${creds.baseUrl}/token/v1/login`;
  const options = {
    method: 'GET',
    headers: {
      ClientID: creds.clientID,
      clientSecret: creds.clientSecret,
    },
  };

  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`BlueDart Login failed ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

// ── Generic HTTP helper ───────────────────────────────────────────────────────
async function callBlueDart(creds, path, bodyObj, method = 'POST') {
  const executeRequest = async (token) => {
    const url = `${creds.baseUrl}${path}`;

    // Log request for debugging (avoid logging sensitive info if possible)
    console.log(`BlueDart Request: ${method} ${url}`);
    if (bodyObj) {
      const sanitizedBody = { ...bodyObj };
      if (sanitizedBody.Profile) sanitizedBody.Profile = '{HIDDEN}';
      if (sanitizedBody.profile) sanitizedBody.profile = '{HIDDEN}';
      console.log(`Request Body: ${JSON.stringify(sanitizedBody)}`);
    }

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        JWTToken: token,
      },
    };

    if (method !== 'GET' && bodyObj !== undefined) {
      options.body = JSON.stringify(bodyObj);
    }

    return fetch(url, options);
  };

  let res = await executeRequest(creds.jwtToken);

  // If unauthorized and we have client credentials, try to get a new token and retry
  if (res.status === 401 && creds.clientID && creds.clientSecret) {
    console.log('Unauthorized (401). Attempting to refresh token...');
    try {
      const tokenData = await getToken(creds);
      if (tokenData && tokenData.JWTToken) {
        cachedJwtToken = tokenData.JWTToken;
        creds.jwtToken = tokenData.JWTToken;
        res = await executeRequest(creds.jwtToken);
      }
    } catch (tokenErr) {
      console.error('Token refresh failed:', tokenErr.message);
      // Fall through to original error handling
    }
  }

  // Retry on transient 5xx errors (e.g. 500 Internal Server Error)
  if (res.status >= 500) {
    console.log(`BlueDart API returned ${res.status}. Retrying in 500ms...`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    res = await executeRequest(creds.jwtToken);
  }

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text);
    } catch (_) {}
    throw new Error(
      `BlueDart API error ${res.status}: ${JSON.stringify(detail)}`,
    );
  }

  if (contentType.includes('xml')) {
    return { rawXml: text };
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

// ── GET helper (for tracking) ─────────────────────────────────────────────────
async function callBlueDartGet(creds, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return callBlueDart(creds, `${path}?${qs}`, undefined, 'GET');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * generate_waybill
 * Required payload fields (minimum domestic):
 *   consignee: { name, address1, pincode, mobile }
 *   shipper:   { customerCode, originArea, pincode }
 *   services:  { productCode, actualWeight, pieceCount, declaredValue,
 *                pickupDate, creditReferenceNo }
 *
 * For full field list see the Waybill API docs.
 * We merge caller-supplied fields over sensible defaults.
 */
const cleanPhone = (p) => (p ? p.toString().replace(/\D/g, '').slice(-10) : '');

async function generateWaybill(creds, payload) {
  const {
    consignee = {},
    shipper = {},
    services = {},
    returnadds = {},
  } = payload;

  const body = {
    Request: {
      Consignee: {
        ConsigneeName: consignee.name || '',
        ConsigneeAddress1: consignee.address1 || '',
        ConsigneeAddress2: consignee.address2 || '',
        ConsigneeAddress3: consignee.address3 || '',
        ConsigneePincode: consignee.pincode || '',
        ConsigneeMobile: cleanPhone(consignee.mobile),
        ConsigneeTelephone: consignee.telephone || '',
        ConsigneeEmailID: consignee.email || '',
        ConsigneeAttention: consignee.attention || '',
        ConsigneeCityName: consignee.city || '',
        ConsigneeStateCode: consignee.stateCode || '',
        ConsigneeCountryCode: consignee.countryCode || 'IN',
        ConsigneeGSTNumber: consignee.gstNumber || '',
        ConsigneeAddressType: consignee.addressType || 'O',
        // Pass any extra fields through
        ...consignee._extra,
      },
      Shipper: {
        CustomerCode:
          shipper.customerCode || creds.shipperDefaults.customerCode || '',
        OriginArea:
          shipper.originArea || creds.shipperDefaults.originArea || '',
        CustomerPincode: shipper.pincode || creds.shipperDefaults.pincode || '',
        Sender: shipper.name || creds.shipperDefaults.name || '',
        CustomerName: shipper.name || creds.shipperDefaults.name || '',
        CustomerAddress1:
          shipper.address1 || creds.shipperDefaults.address1 || '',
        CustomerAddress2: shipper.address2 || '',
        CustomerAddress3: shipper.address3 || '',
        CustomerMobile: cleanPhone(
          shipper.mobile || creds.shipperDefaults.mobile,
        ),
        CustomerTelephone: shipper.telephone || '',
        CustomerEmailID: shipper.email || '',
        CustomerGSTNumber: shipper.gstNumber || '',
        IsToPayCustomer: shipper.isToPayCustomer ?? false,
        ...shipper._extra,
      },
      Services: {
        ProductCode: services.productCode || 'A',
        SubProductCode:
          services.subProductCode ||
          (services.collectableAmount > 0 ? 'C' : 'P'),
        ActualWeight: String(services.actualWeight || 0.5),
        PieceCount: String(services.pieceCount || 1),
        DeclaredValue: services.declaredValue || 0,
        CollactableAmount: services.collectableAmount || 0,
        CreditReferenceNo: services.creditReferenceNo 
          ? `${services.creditReferenceNo.toString().substring(0, 15)}-${Date.now().toString(36).slice(-4)}`
          : '',
        InvoiceNo: services.invoiceNo || '',
        PickupDate: services.pickupDate
          ? services.pickupDate.startsWith('/Date')
            ? services.pickupDate
            : `/Date(${new Date(services.pickupDate).getTime()})/`
          : `/Date(${Date.now()})/`,
        PickupTime: services.pickupTime || '1600',
        PackType: services.packType || '',
        RegisterPickup: services.registerPickup ?? false,
        IsReversePickup: services.isReversePickup ?? false,
        IsForcePickup: services.isForcePickup ?? false,
        PDFOutputNotRequired: services.pdfOutputNotRequired ?? false,
        ProductType: 1,
        Dimensions: services.dimensions || [],
        itemdtl: services.items || [],
        SpecialInstruction: services.specialInstruction || '',
        ...services._extra,
      },
      Returnadds: {
        ReturnAddress1: returnadds.address1 || '',
        ReturnPincode: returnadds.pincode || '',
        ReturnContact: returnadds.contact || '',
        ReturnMobile: returnadds.mobile || '',
        ReturnTelephone: returnadds.telephone || '',
        ReturnEmailID: returnadds.email || '',
        ...returnadds._extra,
      },
    },
    Profile: creds.Profile,
  };

  const res = await callBlueDart(creds, '/waybill/v1/GenerateWayBill', body);

  // Handle PDF generation and S3 upload
  if (
    payload.generateAwb &&
    res.GenerateWayBillResult &&
    res.GenerateWayBillResult.AWBPrintContent
  ) {
    try {
      const pdfBytes = res.GenerateWayBillResult.AWBPrintContent;
      const buffer = Buffer.from(pdfBytes);
      const awbNo = res.GenerateWayBillResult.AWBNo;

      // SECURITY: Always use the bucket from Environment Variables (locked down)
      const targetBucket = creds.s3.bucket;
      const orderId = payload.orderId;

      if (!targetBucket) {
        throw new Error('Missing AWB_S3_BUCKET environment variable.');
      }

      // Only the folder/filename is dynamic based on the orderId
      if (!orderId) {
        throw new Error(
          'orderId is required in payload for S3 AWB generation.',
        );
      }

      // Sanitize orderId to prevent potential path traversal
      const safeOrderId = orderId.toString().replace(/[^a-zA-Z0-9_-]/g, '');
      const key = `orders/${safeOrderId}/awb-${safeOrderId}.pdf`;

      const s3Client = new S3Client({ region: creds.s3.region });

      // Validate if bucket exists and is accessible
      try {
        await s3Client.send(new HeadBucketCommand({ Bucket: targetBucket }));
      } catch (err) {
        throw new Error(
          `S3 Bucket "${targetBucket}" is not accessible: ${err.message}`,
        );
      }

      await s3Client.send(
        new PutObjectCommand({
          Bucket: targetBucket,
          Key: key,
          Body: buffer,
          ContentType: 'application/pdf',
        }),
      );

      // Append S3 URL to response
      res.GenerateWayBillResult.awbPdfUrl = `https://${targetBucket}.s3.${creds.s3.region}.amazonaws.com/${key}`;
    } catch (s3Err) {
      console.error('S3 operation failed:', s3Err.message);
      res.GenerateWayBillResult.s3Error = s3Err.message;
    }
  }

  return res;
}

/**
 * cancel_waybill
 * payload: { awbNo }
 */
async function cancelWaybill(creds, payload) {
  if (!payload.awbNo) throw new Error('payload.awbNo is required');

  try {
    return await callBlueDart(creds, '/waybill/v1/CancelWaybill', {
      Request: { AWBNo: payload.awbNo },
      Profile: creds.Profile,
    });
  } catch (err) {
    const msg = err.message.toLowerCase();
    if (msg.includes('cancelled') || msg.includes('not register')) {
      console.log(`Notice: AWB ${payload.awbNo} already cancelled or not registered. Treating as success.`);
      return { success: true, message: msg };
    }
    throw err;
  }
}

/**
 * update_ewaybill
 * payload: {
 *   waybillNumber, eWaybillNumber, eWaybillDate (ms timestamp),
 *   invoiceNumber, invoiceDate (ms timestamp), sellerGSTNo
 * }
 */
async function updateEwaybill(creds, payload) {
  const toDate = (ts) => `/Date(${ts})/`;

  return callBlueDart(creds, '/waybill/v1/UpdateEwayBill', {
    ERequest: {
      Waybillnumber: payload.waybillNumber || '',
      eWaybillNumber: payload.eWaybillNumber || '',
      eWaybillDate: toDate(payload.eWaybillDate || Date.now()),
      InvoiceNumber: payload.invoiceNumber || '',
      InvoiceDate: toDate(payload.invoiceDate || Date.now()),
      SellerGSTNo: payload.sellerGSTNo || '',
    },
    Profile: creds.Profile,
  });
}

/**
 * register_pickup
 * payload: {
 *   customerCode, customerName, address1, address2, address3,
 *   pincode, areaCode, routeCode, contactPersonName, mobile, telephone, email,
 *   productCode, subProducts (array), pickupDate (ms timestamp), pickupTime,
 *   officeCloseTime, numberOfPieces, weight, volumeWeight,
 *   doxNdox, packType, remarks, referenceNo,
 *   isReversePickup, isForcePickup, isCISDDN, isToPayShipper,
 *   awbNos (array of AWB strings)
 * }
 */
async function registerPickup(creds, payload) {
  const toDate = (ts) => `/Date(${ts})/`;
  const parseDate = (d, t) => {
    if (!d) return Date.now();
    if (typeof d === 'number') return d;

    // Combine date and time for a more accurate timestamp if needed
    let dateStr = d;
    if (t && typeof d === 'string' && !d.includes('T') && !d.includes(':')) {
      dateStr = `${d} ${t}`;
    }

    const parsed = new Date(dateStr).getTime();
    return isNaN(parsed) ? Date.now() : parsed;
  };

  const awbNos = Array.isArray(payload.awbNos)
    ? payload.awbNos.map((a) => a?.toString().trim()).filter((a) => !!a)
    : payload.awbNo
      ? [payload.awbNo.toString().trim()]
      : [];

  if (awbNos.length === 0) {
    throw new Error(
      'At least one AWB number (awbNo or awbNos) is required for pickup registration.',
    );
  }

  return callBlueDart(creds, '/pickup/v1/RegisterPickup', {
    request: {
      AWBNo: awbNos,
      AreaCode: (
        payload.areaCode ||
        creds.shipperDefaults.originArea ||
        'MAA'
      ).substring(0, 3),
      CISDDN: payload.isCISDDN ?? false,
      ContactPersonName:
        payload.contactPersonName ||
        payload.customerName ||
        creds.shipperDefaults.name ||
        'Admin',
      CustomerAddress1:
        payload.address1 || creds.shipperDefaults.address1 || '',
      CustomerAddress2: payload.address2 || '',
      CustomerAddress3: payload.address3 || '',
      CustomerCode: (
        payload.customerCode ||
        creds.shipperDefaults.customerCode ||
        ''
      ).substring(0, 6),
      CustomerName:
        payload.customerName || creds.shipperDefaults.name || 'VYBN',
      CustomerPincode: (
        payload.pincode ||
        creds.shipperDefaults.pincode ||
        ''
      ).substring(0, 6),
      CustomerTelephoneNumber: (
        payload.telephone ||
        payload.mobile ||
        creds.shipperDefaults.mobile ||
        ''
      ).substring(0, 15),
      DoxNDox: payload.doxNdox || '1',
      EmailID: payload.email || '',
      IsForcePickup: payload.isForcePickup ?? false,
      IsReversePickup: payload.isReversePickup ?? false,
      MobileTelNo: (
        payload.mobile ||
        creds.shipperDefaults.mobile ||
        ''
      ).substring(0, 15),
      NumberofPieces: Number(payload.numberOfPieces || payload.pieceCount || 1),
      OfficeCloseTime: payload.officeCloseTime || '20:00',
      PackType: payload.packType || '',
      ProductCode: payload.productCode || 'A',
      ReferenceNo: (payload.referenceNo || '').substring(0, 20),
      Remarks: payload.remarks || '',
      RouteCode: payload.routeCode || creds.shipperDefaults.routeCode || '',
      ShipmentPickupDate: toDate(
        parseDate(payload.pickupDate, payload.pickupTime),
      ),
      ShipmentPickupTime: payload.pickupTime || '16:00',
      SubProducts:
        Array.isArray(payload.subProducts) && payload.subProducts.length > 0
          ? payload.subProducts
          : ['E-Tailing'],
      VolumeWeight:
        Math.round(
          Number(payload.volumeWeight || payload.weight || 0.5) * 100,
        ) / 100,
      WeightofShipment: Math.round(Number(payload.weight || 0.5) * 100) / 100,
      isToPayShipper: payload.isToPayShipper ?? false,
    },
    profile: creds.profile,
  });
}

/**
 * cancel_pickup
 * payload: { tokenNumber, pickupDate (ms timestamp), remarks }
 */
async function cancelPickup(creds, payload) {
  if (!payload.tokenNumber) throw new Error('payload.tokenNumber is required');

  const toDate = (ts) => `/Date(${ts})/`;
  const parseDate = (d) => {
    if (!d) return Date.now();
    if (typeof d === 'number') return d;
    const parsed = new Date(d).getTime();
    return isNaN(parsed) ? Date.now() : parsed;
  };

  try {
    return await callBlueDart(creds, '/cancel-pickup/v1/CancelPickup', {
      request: {
        TokenNumber: Number(payload.tokenNumber),
        PickupRegistrationDate: toDate(parseDate(payload.pickupDate)),
        Remarks: payload.remarks || 'Cancelled by admin',
      },
      profile: creds.profile,
    });
  } catch (err) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('cancelled') ||
      msg.includes('not found') ||
      msg.includes('not register') ||
      msg.includes('invalid token')
    ) {
      console.log(`Notice: Pickup ${payload.tokenNumber} already inactive. Treating as success.`);
      return { success: true, message: msg };
    }
    throw err;
  }
}

/**
 * track_shipment
 * payload: {
 *   awbNumber         — track by AWB (most common)
 *   referenceNumber   — track by customer reference (set awbType="Ref")
 *   scan              — "1" to include full scan history (default "1")
 * }
 *
 * Returns raw XML wrapped in { rawXml: "..." }
 * Parse it with your preferred XML library on the caller side,
 * or set parseXml: true in payload to get a simplified JS object.
 */
async function trackShipment(creds, payload) {
  if (!payload.awbNumber && !payload.referenceNumber) {
    throw new Error('payload.awbNumber or payload.referenceNumber is required');
  }

  const params = {
    handler: 'tnt',
    loginid: creds.trackingProfile.LoginID,
    lickey: creds.trackingProfile.LicenceKey,
    verno: '1',
    action: 'custawbquery',
    format: 'xml',
    scan: payload.scan ?? '1',
    awb: payload.referenceNumber ? 'Ref' : 'awb',
    numbers: payload.awbNumber || payload.referenceNumber,
  };

  const result = await callBlueDartGet(creds, '/tracking/v1/shipment', params);

  // Optional: parse XML into a cleaner JS object
  if (payload.parseXml && result.rawXml) {
    return { parsed: parseTrackingXml(result.rawXml), rawXml: result.rawXml };
  }

  return result;
}

/**
 * get_transit_time  (delivery time estimator)
 * payload: {
 *   fromPincode, toPincode, productCode, subProductCode,
 *   pickupDate (ms timestamp), pickupTime ("16:00")
 * }
 */
async function getTransitTime(creds, payload) {
  const toDate = (ts) => `/Date(${ts})/`;

  return callBlueDart(
    creds,
    '/transit/v1/GetDomesticTransitTimeForPinCodeandProduct',
    {
      pPinCodeFrom: payload.fromPincode || '',
      pPinCodeTo: payload.toPincode || '',
      pProductCode: payload.productCode || 'A',
      pSubProductCode: payload.subProductCode || 'P',
      pPudate: toDate(payload.pickupDate || Date.now()),
      pPickupTime: payload.pickupTime || '16:00',
      profile: creds.profile,
    },
  );
}

/**
 * get_services_for_pincode  (location finder + serviceability + cost limits)
 * payload: { pincode }
 */
async function getServicesForPincode(creds, payload) {
  if (!payload.pincode) throw new Error('payload.pincode is required');

  return callBlueDart(creds, '/finder/v1/GetServicesforPincode', {
    pinCode: payload.pincode,
    profile: creds.profile,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  XML PARSER  (lightweight — no dependencies)
//  Parses the tracking XML into a clean JS object.
// ═══════════════════════════════════════════════════════════════════════════════
function parseTrackingXml(xml) {
  // Extract a tag's inner text
  const tag = (src, name) => {
    const m = src.match(
      new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'),
    );
    return m ? m[1].trim() : '';
  };

  const shipmentMatch = xml.match(/<Shipment[\s\S]*?<\/Shipment>/i);
  if (!shipmentMatch) return { error: 'No shipment data in response' };

  const s = shipmentMatch[0];

  // Parse scans
  const scans = [];
  const scanMatches = s.matchAll(/<ScanDetail>([\s\S]*?)<\/ScanDetail>/gi);
  for (const m of scanMatches) {
    const sd = m[1];
    scans.push({
      scan: tag(sd, 'Scan'),
      scanCode: tag(sd, 'ScanCode'),
      scanType: tag(sd, 'ScanType'),
      scanGroupType: tag(sd, 'ScanGroupType'),
      scanDate: tag(sd, 'ScanDate'),
      scanTime: tag(sd, 'ScanTime'),
      location: tag(sd, 'ScannedLocation'),
      locationCode: tag(sd, 'ScannedLocationCode'),
    });
  }

  return {
    refNo: tag(s, 'RefNo') || (s.match(/RefNo="([^"]*)"/) || [])[1],
    waybillNo: tag(s, 'WaybillNo') || (s.match(/WaybillNo="([^"]*)"/) || [])[1],
    productCode: tag(s, 'Prodcode'),
    service: tag(s, 'Service'),
    pickupDate: tag(s, 'PickUpDate'),
    pickupTime: tag(s, 'PickUpTime'),
    origin: tag(s, 'Origin'),
    destination: tag(s, 'Destination'),
    productType: tag(s, 'ProductType'),
    senderName: tag(s, 'SenderName'),
    toAttention: tag(s, 'ToAttention'),
    weight: tag(s, 'Weight'),
    status: tag(s, 'Status'),
    statusType: tag(s, 'StatusType'),
    expectedDelivery: tag(s, 'ExpectedDeliveryDate'),
    statusDate: tag(s, 'StatusDate'),
    statusTime: tag(s, 'StatusTime'),
    receivedBy: tag(s, 'ReceivedBy'),
    scans,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
const ACTIONS = {
  generate_waybill: generateWaybill,
  cancel_waybill: cancelWaybill,
  update_ewaybill: updateEwaybill,
  register_pickup: registerPickup,
  cancel_pickup: cancelPickup,
  track_shipment: trackShipment,
  get_transit_time: getTransitTime,
  get_services_for_pincode: getServicesForPincode,
  get_token: getToken,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  LAMBDA HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
export const handler = async (event) => {
  // ── Parse incoming event ──────────────────────────────────────────────────
  // Supports: direct invocation, API Gateway v1 (REST), API Gateway v2 (HTTP)
  let action, payload;

  try {
    let body = event;

    // API Gateway wraps the body as a string
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else if (typeof event.body === 'object' && event.body !== null) {
      body = event.body;
    }

    action = body.action;
    payload = body.payload || {};
  } catch (parseErr) {
    return respond(400, { success: false, error: 'Invalid JSON body' });
  }

  // ── Validate action ───────────────────────────────────────────────────────
  if (!action) {
    return respond(400, {
      success: false,
      error: 'Missing "action" field',
      availableActions: Object.keys(ACTIONS),
    });
  }

  const handler_fn = ACTIONS[action];
  if (!handler_fn) {
    return respond(400, {
      success: false,
      error: `Unknown action "${action}"`,
      availableActions: Object.keys(ACTIONS),
    });
  }

  // ── Resolve credentials ───────────────────────────────────────────────────
  let creds;
  try {
    creds = await getCredentials();
  } catch (credErr) {
    console.error('Credential error:', credErr.message);
    return respond(500, {
      success: false,
      error: 'Lambda misconfiguration: ' + credErr.message,
    });
  }

  // ── Execute action ────────────────────────────────────────────────────────
  try {
    const data = await handler_fn(creds, payload);
    return respond(200, { success: true, action, data });
  } catch (err) {
    console.error(`Action "${action}" failed:`, err);
    return respond(502, { success: false, action, error: err.message });
  }
};

// ── HTTP response helper ──────────────────────────────────────────────────────
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // tighten to your domain in production
    },
    body: JSON.stringify(body),
  };
}
