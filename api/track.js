/**
 * DHARMIK ORDER TRACKING API - DUAL COURIER (DELHIVERY + SHIPROCKET)
 * Supports tracking by Order ID and AWB for both couriers
 */

let shiprocketToken = null;
let shiprocketTokenExpiry = null;

const SHOPIFY_CHANNEL_ID = 8455465;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { orderId, orderNumber, awb } = req.query;
    
    // Track by AWB (Waybill)
    if (awb) {
      const tracking = await trackByAWB(awb);
      return res.status(200).json(tracking);
    }
    
    // Track by Order ID
    if (orderId || orderNumber) {
      const tracking = await trackByOrderId(orderId || orderNumber);
      return res.status(200).json(tracking);
    }
    
    return res.status(400).json({ 
      error: 'Missing parameters',
      usage: {
        byOrderId: '/api/track?orderId=8440',
        byAWB: '/api/track?awb=1234567890'
      }
    });
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Something went wrong',
      message: error.message 
    });
  }
}

// Track by Order ID - Try both Delhivery and Shiprocket
async function trackByOrderId(orderIdentifier) {
  const cleanOrderId = orderIdentifier.toString()
    .replace(/^#/, '')
    .replace(/^DHK/i, '')
    .trim();
  
  // Try Delhivery first
  try {
    const delhiveryData = await trackDelhiveryByOrderId(cleanOrderId);
    if (delhiveryData && delhiveryData.ShipmentData && delhiveryData.ShipmentData.length > 0) {
      return formatDelhiveryResponse(delhiveryData);
    }
  } catch (err) {
    console.log('Delhivery Order ID lookup failed, trying Shiprocket...');
  }
  
  // Fallback to Shiprocket
  try {
    const shiprocketData = await trackShiprocketByOrderId(cleanOrderId);
    return shiprocketData;
  } catch (err) {
    throw new Error('Order not found. Please check your order number.');
  }
}

// Track by AWB - Try both Delhivery and Shiprocket
async function trackByAWB(awb) {
  const cleanAWB = awb.toString().trim();
  
  // Try Delhivery first
  try {
    const delhiveryData = await trackDelhiveryByAWB(cleanAWB);
    if (delhiveryData && delhiveryData.ShipmentData && delhiveryData.ShipmentData.length > 0) {
      return formatDelhiveryResponse(delhiveryData);
    }
  } catch (err) {
    console.log('Delhivery AWB lookup failed, trying Shiprocket...');
  }
  
  // Fallback to Shiprocket
  try {
    const shiprocketData = await trackShiprocketByAWB(cleanAWB);
    return shiprocketData;
  } catch (err) {
    throw new Error('Tracking information not found');
  }
}

// ==================== DELHIVERY API ====================

async function trackDelhiveryByOrderId(orderId) {
  const delhiveryToken = process.env.DELHIVERY_API_TOKEN;
  
  if (!delhiveryToken) {
    throw new Error('Delhivery API token not configured');
  }
  
  // Delhivery uses "ref_ids" parameter for Order ID tracking
  const response = await fetch(
    `https://track.delhivery.com/api/v1/packages/json/?ref_ids=${encodeURIComponent(orderId)}`,
    {
      headers: {
        'Authorization': `Token ${delhiveryToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error('Delhivery order tracking failed');
  }
  
  return data;
}

async function trackDelhiveryByAWB(awb) {
  const delhiveryToken = process.env.DELHIVERY_API_TOKEN;
  
  if (!delhiveryToken) {
    throw new Error('Delhivery API token not configured');
  }
  
  const response = await fetch(
    `https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
    {
      headers: {
        'Authorization': `Token ${delhiveryToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error('Delhivery tracking failed');
  }
  
  return data;
}

function formatDelhiveryResponse(data) {
  const shipment = data.ShipmentData[0];
  const scans = shipment.Scans || [];
  
  // Sort scans by date (newest first)
  const sortedScans = scans.sort((a, b) => {
    return new Date(b.ScanDetail.ScanDateTime) - new Date(a.ScanDetail.ScanDateTime);
  });
  
  // Format to match Shiprocket structure
  return [{
    tracking_data: {
      track_status: 1,
      shipment_status: getShiprocketStatusCode(shipment.Status.Status),
      courier_source: 'delhivery',
      shipment_track: [{
        id: shipment.Shipment.ReferenceNo,
        awb_code: shipment.Shipment.AWB,
        courier_company_id: null,
        shipment_id: shipment.Shipment.ReferenceNo,
        order_id: shipment.Shipment.ReferenceNo,
        pickup_date: shipment.Shipment.PickUpDate || '',
        delivered_date: shipment.Shipment.DeliveryDate || '',
        weight: shipment.Shipment.ChargeableWeight || '0',
        packages: 1,
        current_status: shipment.Status.Status,
        delivered_to: shipment.Shipment.DestinationArea,
        destination: shipment.Shipment.DestinationArea,
        consignee_name: shipment.Shipment.Consignee.Name,
        origin: shipment.Shipment.OriginArea,
        courier_agent_details: null,
        courier_name: 'Delhivery',
        edd: shipment.Shipment.ExpectedDeliveryDate || null,
        pod: shipment.Shipment.POD || null,
        pod_status: shipment.Shipment.PODStatus || null,
        rto_delivered_date: null,
        return_awb_code: '',
        updated_time_stamp: sortedScans[0]?.ScanDetail?.ScanDateTime || null
      }],
      shipment_track_activities: sortedScans.map(scan => ({
        date: scan.ScanDetail.ScanDateTime,
        status: scan.ScanDetail.Scan,
        activity: scan.ScanDetail.Instructions || scan.ScanDetail.Scan,
        location: scan.ScanDetail.ScannedLocation,
        'sr-status': getShiprocketStatusCode(scan.ScanDetail.Scan),
        'sr-status-label': scan.ScanDetail.Scan
      })),
      track_url: `https://www.delhivery.com/track/package/${shipment.Shipment.AWB}`,
      etd: shipment.Shipment.ExpectedDeliveryDate || null,
      qc_response: '',
      is_return: false,
      order_tag: ''
    }
  }];
}

// Map Delhivery status to Shiprocket-like status codes
function getShiprocketStatusCode(status) {
  const statusUpper = status.toUpperCase();
  
  if (statusUpper.includes('DELIVERED')) return '8';
  if (statusUpper.includes('OUT FOR DELIVERY')) return '7';
  if (statusUpper.includes('IN TRANSIT') || statusUpper.includes('DISPATCHED')) return '6';
  if (statusUpper.includes('PICKED') || statusUpper.includes('PICKUP')) return '42';
  if (statusUpper.includes('PENDING') || statusUpper.includes('MANIFESTED')) return '1';
  if (statusUpper.includes('RTO')) return '9';
  if (statusUpper.includes('CANCELLED')) return '11';
  
  return '6'; // Default to in-transit
}

// ==================== SHIPROCKET API ====================

async function getShiprocketToken() {
  if (shiprocketToken && shiprocketTokenExpiry && Date.now() < shiprocketTokenExpiry) {
    return shiprocketToken;
  }
  
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  
  if (!email || !password) {
    throw new Error('Shiprocket credentials not configured');
  }
  
  const response = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.message || 'Shiprocket authentication failed');
  }
  
  shiprocketToken = data.token;
  shiprocketTokenExpiry = Date.now() + (9 * 24 * 60 * 60 * 1000);
  
  return shiprocketToken;
}

async function trackShiprocketByOrderId(orderId) {
  const token = await getShiprocketToken();
  
  const response = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track?order_id=${encodeURIComponent(orderId)}&channel_id=${SHOPIFY_CHANNEL_ID}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  const data = await response.json();
  
  if (!response.ok || !data || data.length === 0) {
    throw new Error('Order not found in Shiprocket');
  }
  
  // Add courier source flag
  if (data[0] && data[0].tracking_data) {
    data[0].tracking_data.courier_source = 'shiprocket';
  }
  
  return data;
}

async function trackShiprocketByAWB(awb) {
  const token = await getShiprocketToken();
  
  const response = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${encodeURIComponent(awb)}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error('AWB not found in Shiprocket');
  }
  
  // Format to match expected structure
  return [{
    tracking_data: {
      ...data.tracking_data,
      courier_source: 'shiprocket'
    }
  }];
}
