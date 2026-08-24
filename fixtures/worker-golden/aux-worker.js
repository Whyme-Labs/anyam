export default {
  fetch() {
    return new Response(JSON.stringify({ status: "healthy", service: "anyam-golden-aux" }), {
      headers: { "content-type": "application/json" },
    });
  },
};
