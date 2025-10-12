async function startCheckout(){
    const response = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers:{
            'Content-Type': 'application/json'
        },
    });
    const data = await response.json();
    window.location.href = data.url;
}