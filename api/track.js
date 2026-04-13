// File: api/track.js
// Deploy this in your Vercel project root under /api/track.js
// It will be accessible at: https://your-vercel-domain.vercel.app/api/track?order_id=1042

export default async function handler(req, res) {
  // Enable CORS for your Shopify domain
  res.setHeader("Access-Control-Allow-Origin", "*"); // Replace * with your Shopify domain in production
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { order_id } = req.query;

  if (!order_id) {
    return res.status(400).json({ error: "Order ID is required" });
  }

  try {
    // Step 1: Get Shiprocket auth token
    const authResponse = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      }),
    });

    if (!authResponse.ok) {
      throw new Error("Shiprocket authentication failed");
    }

    const authData = await authResponse.json();
    const token = authData.token;

    // Step 2: Search for the order using Shopify order number
    // Shiprocket's order search endpoint lets us find by channel_order_id (Shopify order number)
    const orderResponse = await fetch(
      `https://apiv2.shiprocket.in/v1/external/orders?search=${order_id}&page=1&per_page=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!orderResponse.ok) {
      throw new Error("Failed to fetch order from Shiprocket");
    }

    const orderData = await orderResponse.json();

    // Check if order was found
    if (!orderData.data || orderData.data.length === 0) {
      return res.status(404).json({ error: "Order not found. Please check your order number." });
    }

    const order = orderData.data[0];
    const shipments = order.shipments;

    // If no shipment yet (order not shipped)
    if (!shipments || shipments.length === 0) {
      return res.status(200).json({
        order_id: order.channel_order_id,
        status: order.status_code === 1 ? "NEW" : order.status,
        message: "Your order has been received and is being processed. Shipping details will be available soon.",
        shipped: false,
        order_date: order.created_at,
        customer_name: `${order.customer_name || ""}`.trim(),
        products: order.products || [],
      });
    }

    // Step 3: Get tracking data using AWB number
    const awb = shipments[0].awb;
    const courier = shipments[0].courier_name;

    if (!awb) {
      return res.status(200).json({
        order_id: order.channel_order_id,
        status: "PROCESSING",
        message: "Your order is being prepared for shipping. Tracking will be available once shipped.",
        shipped: false,
        order_date: order.created_at,
        customer_name: `${order.customer_name || ""}`.trim(),
        products: order.products || [],
      });
    }

    const trackResponse = await fetch(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!trackResponse.ok) {
      throw new Error("Failed to fetch tracking data");
    }

    const trackData = await trackResponse.json();
    const tracking = trackData.tracking_data || {};

    return res.status(200).json({
      order_id: order.channel_order_id,
      shipped: true,
      awb: awb,
      courier: courier,
      status: tracking.shipment_status_id
        ? getStatusLabel(tracking.shipment_status_id)
        : shipments[0].status,
      current_status: tracking.shipment_track?.[0]?.current_status || "",
      etd: tracking.etd || "",
      order_date: order.created_at,
      customer_name: `${order.customer_name || ""}`.trim(),
      shipment_track: tracking.shipment_track || [],
      shipment_track_activities: tracking.shipment_track_activities || [],
      products: order.products || [],
    });
  } catch (error) {
    console.error("Tracking error:", error);
    return res.status(500).json({
      error: "Something went wrong while fetching tracking info. Please try again.",
    });
  }
}

function getStatusLabel(statusId) {
  const statusMap = {
    1: "AWB Assigned",
    2: "Picked Up",
    3: "In Transit",
    4: "Out for Delivery",
    5: "Delivered",
    6: "Undelivered",
    7: "Returned",
    8: "Cancelled",
  };
  return statusMap[statusId] || "In Process";
}
