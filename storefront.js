(() => {
  'use strict';

  const app = document.querySelector('#app');
  const loadingScreen = document.querySelector('#loading-screen');
  const initialization = new AbortController();
  const initializationTimeout = setTimeout(() => initialization.abort(), 20000);
  let initializing = true;
  let translationInitialized = false;
  const cartKey = 'torquex.cart';
  const currencyKey = 'torquex.currency';
  const promoKey = 'torquex.promo';
  const pendingCryptoOrderKey = 'torquex.pendingCryptoOrder';
  const state = { user: null, token: null, rates: null, currency: 'USD', cars: [], timer: null, contact: null };
  let heroSwiper = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const escWithBrand = value => esc(value).replace(/\b(?:turquex|torquex)\b/gi, match => `<span class="notranslate" translate="no">${match}</span>`);
  const cartItems = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(cartKey) || '[]');
      if (!Array.isArray(saved)) return [];
      return saved.map(item => typeof item === 'string' ? { carId: item, quantity: 1 } : item)
        .filter(item => item && typeof item.carId === 'string' && Number.isInteger(item.quantity) && item.quantity > 0);
    }
    catch { return []; }
  };
  const saveCart = items => {
    localStorage.setItem(cartKey, JSON.stringify(items));
    updateCartCount();
  };
  const updateCartCount = () => {
    const count = document.querySelector('#cart-count');
    if (count) count.textContent = String(cartItems().reduce((sum, item) => sum + item.quantity, 0));
  };
  const formatMoney = amountUsd => {
    const rate = state.rates?.rates?.[state.currency];
    if (typeof rate !== 'number') {
      return state.currency === 'USD'
        ? `$${Number(amountUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
        : 'Rate unavailable';
    }
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency, maximumFractionDigits: 2 })
      .format(Number(amountUsd) * rate);
  };
  const formatDate = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const shipmentLabels = {
    preparing: 'Preparing',
    in_transit: 'In transit',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered'
  };
  const trackingLink = code => `${location.origin}/track#${encodeURIComponent(code)}`;

  function trackingMarkup(tracking) {
    if (!tracking) return '';
    const emailNotice = tracking.emailStatus === 'sent' ? 'The tracking email was accepted by the mail server.' :
      tracking.emailStatus === 'failed' ? 'The tracking email could not be sent. Save this link or ask the dealership to resend it.' :
        tracking.emailStatus === 'pending' ? 'The tracking email is pending.' : 'No tracking email has been sent for this order.';
    return `<div class="tracking-card"><span class="eyebrow">Private order tracking</span>
      <div class="tracking-code">${esc(tracking.code)}</div><p class="muted">${esc(emailNotice)} Anyone with this code or link can view shipment progress.</p>
      <div class="button-row"><a class="button button-secondary" href="${esc(trackingLink(tracking.code))}">Track order</a><button type="button" class="button-secondary copy-tracking" data-code="${esc(tracking.code)}"><i class="ri-file-copy-line" aria-hidden="true"></i> Copy link</button></div></div>`;
  }

  function bindTrackingControls(container) {
    container.querySelectorAll('.copy-tracking').forEach(button => button.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard) throw new Error('Clipboard unavailable.');
        await navigator.clipboard.writeText(trackingLink(button.dataset.code));
        toast('Tracking link copied.');
      } catch (error) {
        console.error('Could not copy the tracking link:', error);
        toast('Could not copy the link. Open Track order and copy it from the address bar.');
      }
    }));
  }

  async function api(url, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (options.method && options.method !== 'GET' && state.token) headers['X-CSRF-Token'] = state.token;
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin', ...(initializing ? { signal: initialization.signal } : {}), ...options, headers });
    } catch (error) {
      if (initializing && initialization.signal.aborted) throw new Error('The page took too long to load. Please try again.');
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    if (data.token) state.token = data.token;
    return data;
  }

  function toast(message) {
    const element = document.querySelector('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 3500);
  }

  function renderAuth() {
    const auth = document.querySelector('#auth-links');
    const userLinks = document.querySelector('#user-links');
    const name = document.querySelector('#user-name');
    const admin = document.querySelector('#admin-link');
    if (!auth || !userLinks) return;
    auth.hidden = Boolean(state.user);
    userLinks.hidden = !state.user;
    if (state.user) {
      name.innerHTML = `Hi, <span class="notranslate" translate="no">${esc(state.user.name.split(' ')[0])}</span>`;
      admin.hidden = state.user.role !== 'admin';
    }
  }

  function carCard(car) {
    const availability = car.status === 'reserved' ? '<span class="tag">Reserved</span>' :
      car.availableStock ? `<span class="tag">${car.availableStock} available</span>` : '<span class="tag">Out of stock</span>';
    return `<article class="car-card">
      <a href="/cars/${encodeURIComponent(car.id)}"><img src="${esc(car.imageUrl || '/assets/img/deal/2.jpg')}" alt="${esc(`${car.year} ${car.make} ${car.model}`)}" loading="lazy"></a>
      <div class="car-card-body">
        <div class="button-row">${availability}<span class="tag">${esc(car.bodyType)}</span></div>
        <h3><a href="/cars/${encodeURIComponent(car.id)}">${esc(car.year)} ${esc(car.make)} ${esc(car.model)}</a></h3>
        <div class="car-meta"><span>${Number(car.mileage).toLocaleString()} mi</span><span>${esc(car.transmission)}</span></div>
        <div class="button-row" style="justify-content:space-between"><span class="price">${formatMoney(car.priceUsd)}</span><a class="button button-small" href="/cars/${encodeURIComponent(car.id)}">View car</a></div>
      </div>
    </article>`;
  }

  function pageHeading(kicker, title, copy = '') {
    return `<div class="section-heading"><div><span class="eyebrow">${escWithBrand(kicker)}</span><h1>${escWithBrand(title)}</h1>${copy ? `<p class="muted">${escWithBrand(copy)}</p>` : ''}</div></div>`;
  }

  async function loadCars() {
    const data = await api('/api/cars');
    state.cars = data.cars;
    return data.cars;
  }

  async function homePage() {
    const cars = await loadCars();
    const featured = cars.filter(car => car.status === 'available').slice(0, 3);
    app.innerHTML = `<section class="swiper hero-swiper tr-hero" aria-label="Featured collections">
      <div class="swiper-wrapper">
        <div class="swiper-slide hero-slide sales-slide-1">
          <div class="hero-overlay"></div>
          <div class="hero-container"><div class="hero-content" data-swiper-parallax="-300">
            <div class="hero-subtitle">A better way to buy</div>
            <h1 class="hero-title">YOUR NEXT <span class="highlight">DRIVE</span></h1>
            <p class="hero-description">Discover a hand-selected collection of premium vehicles, ready for your next chapter.</p>
            <div class="hero-buttons"><a class="button" href="/cars">Explore inventory</a><a class="button button-outline" href="/account">Track an order</a></div>
          </div></div>
        </div>
        <div class="swiper-slide hero-slide sales-slide-2">
          <div class="hero-overlay"></div>
          <div class="hero-container"><div class="hero-content" data-swiper-parallax="-300">
            <div class="hero-subtitle">Made for the road</div>
            <h2 class="hero-title">DRIVEN BY <span class="highlight">PASSION</span></h2>
            <p class="hero-description">From everyday journeys to unforgettable drives, find a car that fits your lifestyle.</p>
            <div class="hero-buttons"><a class="button" href="/cars">Browse cars</a><a class="button button-outline" href="/register">Create account</a></div>
          </div></div>
        </div>
        <div class="swiper-slide hero-slide sales-slide-3">
          <div class="hero-overlay"></div>
          <div class="hero-container"><div class="hero-content" data-swiper-parallax="-300">
            <div class="hero-subtitle">The <span class="notranslate brand-inline" translate="no">TurqueX</span> collection</div>
            <h2 class="hero-title">FIND YOUR <span class="highlight">MATCH</span></h2>
            <p class="hero-description">Explore vehicle details, save your favorites and reserve your selection online.</p>
            <div class="hero-buttons"><a class="button" href="/cars">View collection</a><a class="button button-outline" href="/cart">Saved cars</a></div>
          </div></div>
        </div>
      </div>
      <button class="swiper-button-prev" type="button" aria-label="Previous slide"></button>
      <button class="swiper-button-next" type="button" aria-label="Next slide"></button>
      <div class="swiper-pagination"></div>
      <button class="hero-pause" type="button" aria-label="Pause slideshow">Pause</button>
    </section>
    <section class="home-section" data-aos="fade-up">
      <div class="section-heading"><div><span class="section-badge">The <span class="notranslate brand-inline" translate="no">TurqueX</span> collection</span><h2 class="section-title">FEATURED <span class="accent">VEHICLES</span></h2><div class="section-line"></div><p class="muted">Explore our latest available cars.</p></div><a class="inventory-link" href="/cars">View all inventory <i class="ri-arrow-right-line" aria-hidden="true"></i></a></div>
      <div class="card-grid">${featured.map(carCard).join('') || '<p class="empty-state">New vehicles will be listed soon.</p>'}</div>
    </section>
    <section class="home-intro" data-aos="fade-up">
      <div class="home-intro-copy"><span class="section-badge">Designed for confidence</span><h2 class="section-title">DRIVEN BY <span class="accent">PASSION</span></h2><div class="section-line"></div><p class="muted">Discover the details that matter, find the right vehicle and take the next step from wherever you are.</p><p class="muted">Crypto reservations last one hour. For bank transfers, the one-hour payment window starts when bank details are assigned.</p><a class="button" href="/cars">Browse all cars</a></div>
      <div class="home-intro-image"><img class="notranslate" translate="no" src="/assets/img/deal/5.jpg" alt="Car from the TurqueX collection" loading="lazy"></div>
    </section>
    <section class="home-section" data-aos="fade-up">
      <div class="section-heading"><div><span class="section-badge">Explore the collection</span><h2 class="section-title">MAKES IN <span class="accent">OUR INVENTORY</span></h2><div class="section-line"></div><p class="muted">Browse the makes currently listed on <span class="notranslate brand-inline brand-inline-end" translate="no">TurqueX</span>.</p></div></div>
      <div class="brand-grid">${[...new Set(cars.map(car => car.make))].sort((a, b) => a.localeCompare(b)).map(make => `<a href="/cars" class="brand-tile">${esc(make)}</a>`).join('') || '<p class="muted">Vehicle makes will appear as inventory is added.</p>'}</div>
    </section>
    <section class="home-section" data-aos="fade-up">
      <div class="section-heading"><div><span class="section-badge">Here to help</span><h2 class="section-title">YOUR <span class="notranslate brand-inline" translate="no">TURQUE<span class="accent">X</span></span><span class="accent"> TEAM</span></h2><div class="section-line"></div><p class="muted">From your first question to your next drive, reach out to our team.</p></div></div>
      <div class="card-grid team-grid">
        <article class="panel team-feature"><i class="ri-user-voice-line" aria-hidden="true"></i><h3>Sales conversations</h3><p class="muted">Tell us what you are looking for and request a conversation about your options.</p></article>
        <article class="panel team-feature"><i class="ri-car-line" aria-hidden="true"></i><h3>Vehicle questions</h3><p class="muted">Get in touch about a listing and the details that matter to you.</p></article>
        <article class="panel team-feature"><i class="ri-customer-service-2-line" aria-hidden="true"></i><h3>Order support</h3><p class="muted">Contact us for help with your order or payment questions.</p></article>
      </div>
    </section>
    <section class="home-section home-callout" data-aos="fade-up">
      <div><span class="eyebrow">Let's talk</span><h2>READY FOR YOUR NEXT DRIVE?</h2><p class="muted">Request a call at a time that works for you. Our team will review your request.</p></div>
      <div class="button-row"><a class="button" href="/book-call">Book a call</a><a class="button button-secondary" href="/contact">Contact us</a></div>
    </section>`;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    heroSwiper = new Swiper('.hero-swiper', {
      loop: true,
      speed: reducedMotion ? 0 : 1000,
      effect: 'fade',
      fadeEffect: { crossFade: true },
      parallax: !reducedMotion,
      autoplay: reducedMotion ? false : { delay: 5000, disableOnInteraction: false },
      pagination: { el: '.hero-swiper .swiper-pagination', clickable: true },
      navigation: { nextEl: '.hero-swiper .swiper-button-next', prevEl: '.hero-swiper .swiper-button-prev' }
    });
    const pauseButton = document.querySelector('.hero-pause');
    pauseButton.textContent = reducedMotion ? 'Play' : 'Pause';
    pauseButton.setAttribute('aria-label', reducedMotion ? 'Play slideshow' : 'Pause slideshow');
    pauseButton.addEventListener('click', () => {
      if (heroSwiper.autoplay.running) {
        heroSwiper.autoplay.stop();
        pauseButton.textContent = 'Play';
        pauseButton.setAttribute('aria-label', 'Play slideshow');
      } else {
        heroSwiper.autoplay.start();
        pauseButton.textContent = 'Pause';
        pauseButton.setAttribute('aria-label', 'Pause slideshow');
      }
    });
    if (!reducedMotion) AOS.refreshHard();
  }

  function aboutPage() {
    const address = state.contact?.address;
    app.innerHTML = `<section class="about-hero">
      <div class="about-hero-copy"><span class="section-badge">A world in motion</span>
        <h1>THE DRIVE IS <span class="accent">PERSONAL.</span><br>OUR REACH IS GLOBAL.</h1>
        <p>At <span class="notranslate" translate="no">TurqueX</span>, we believe finding the right car should feel as exciting as driving it. Explore distinctive vehicles and connect with a team ready to help you take the next step.</p>
        <div class="button-row"><a class="button" href="/cars">Explore our cars</a><a class="button button-outline" href="/book-call">Talk to sales</a></div>
      </div>
    </section>
    <section class="about-stats" aria-label="Our reach">
      <div><strong>195</strong><span>countries covered</span></div><div><strong>9.5M+</strong><span>car sales worldwide</span></div><div><strong>1</strong><span>shared passion for driving</span></div>
    </section>
    <section class="home-intro about-story">
      <div class="home-intro-copy"><span class="section-badge">Our story</span><h2 class="section-title">A BETTER WAY <span class="accent">FORWARD</span></h2><div class="section-line"></div>
        <p class="muted">From the first search to the next chapter on the road, we bring the details together in one place. Browse our collection, save the cars that stand out and speak with our team about what matters to you.</p>
        <p class="muted">With deliveries across 195 countries and more than 9.5 million car sales worldwide, <span class="notranslate" translate="no">TurqueX</span> brings a global perspective to every journey.</p>
        <a class="button button-secondary" href="/contact">Get in touch</a></div>
      <div class="home-intro-image"><img src="/assets/img/deal/5.jpg" alt="Car from the TurqueX collection" loading="lazy"></div>
    </section>
    <section class="home-section"><div class="section-heading"><div><span class="section-badge">Made for your journey</span><h2 class="section-title">WHY <span class="notranslate" translate="no">TURQUE<span class="accent">X</span></span></h2><div class="section-line"></div></div></div>
      <div class="card-grid team-grid">
        <article class="panel team-feature"><i class="ri-global-line" aria-hidden="true"></i><h3>Global perspective</h3><p class="muted">Explore a world of possibilities with a team focused on your journey.</p></article>
        <article class="panel team-feature"><i class="ri-car-line" aria-hidden="true"></i><h3>Cars worth discovering</h3><p class="muted">Browse vehicle details and find the make and model that fits your life.</p></article>
        <article class="panel team-feature"><i class="ri-customer-service-2-line" aria-hidden="true"></i><h3>Real conversations</h3><p class="muted">Connect with our sales team for help with vehicles, orders and next steps.</p></article>
      </div>
    </section>
    <section class="about-offers"><div><span class="section-badge">Seasonal offers</span><h2>MORE REASONS TO <span class="accent">DRIVE</span></h2>
      <p>Our Tesla partnership offers 25% off all Tesla models across the Americas, Europe and Asia in November and December, with limited promo-code uses. <span class="notranslate" translate="no">TurqueX</span> also offers 15% off all cars worldwide. Eligible promo codes can be combined for up to 40% off.</p>
      <p class="muted">Promo codes and availability are limited. Contact our team for current codes and eligibility; discounts are applied only when valid codes are entered at checkout.</p>
      <a class="button" href="/contact">Ask about offers</a></div></section>
    <section class="home-section home-callout"><div><span class="eyebrow">We're here to help</span><h2>LET'S FIND YOUR NEXT DRIVE.</h2>
      <p class="muted">${address ? `Visit us: <span class="notranslate" translate="no">${esc(address)}</span>` : 'Get in touch with our team to learn more about our collection.'}</p></div>
      <div class="button-row"><a class="button" href="/book-call">Request a call</a><a class="button button-secondary" href="/contact">Contact us</a></div></section>`;
  }

  async function carsPage() {
    const cars = await loadCars();
    app.innerHTML = `${pageHeading('TurqueX inventory', 'Find your next car', 'Browse current vehicles. Prices can be displayed in your preferred currency.')}
      <div class="search-row"><input id="car-search" type="search" placeholder="Search make, model, body type..." aria-label="Search vehicles"><select id="sort-cars" aria-label="Sort vehicles"><option value="new">Newest year</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option></select></div>
      <div id="car-grid" class="card-grid"></div>`;
    const draw = () => {
      const search = document.querySelector('#car-search').value.toLowerCase().trim();
      const sort = document.querySelector('#sort-cars').value;
      const filtered = cars.filter(car => `${car.year} ${car.make} ${car.model} ${car.bodyType} ${car.transmission}`.toLowerCase().includes(search));
      filtered.sort((a, b) => sort === 'price-low' ? a.priceUsd - b.priceUsd : sort === 'price-high' ? b.priceUsd - a.priceUsd : b.year - a.year);
      document.querySelector('#car-grid').innerHTML = filtered.map(carCard).join('') || '<p class="empty-state">No vehicles match that search.</p>';
    };
    document.querySelector('#car-search').addEventListener('input', draw);
    document.querySelector('#sort-cars').addEventListener('change', draw);
    draw();
  }

  async function carPage(id) {
    const { car } = await api(`/api/cars/${encodeURIComponent(id)}`);
    app.innerHTML = `<div class="detail-grid">
      <img class="detail-image" src="${esc(car.imageUrl || '/assets/img/deal/2.jpg')}" alt="${esc(`${car.year} ${car.make} ${car.model}`)}">
      <section class="panel">
        <span class="eyebrow">${esc(car.year)} · ${esc(car.bodyType)}</span><h1>${esc(car.make)} ${esc(car.model)}</h1>
        <div class="price">${formatMoney(car.priceUsd)}</div>
        <div class="car-meta"><span>${Number(car.mileage).toLocaleString()} miles</span><span>${esc(car.transmission)}</span><span>${car.status === 'reserved' ? 'Currently reserved' : car.availableStock ? `${car.availableStock} available` : 'Out of stock'}</span></div>
        <p class="muted">${escWithBrand(car.description || 'Contact our team for further vehicle details.')}</p>
        ${car.status === 'available' ? '<button id="add-car" class="button">Add to saved cars</button>' : '<div class="notice">This vehicle is currently unavailable. Check back later.</div>'}
        <p class="muted" style="margin-top:18px">Displayed currency is an estimate based on current exchange rates. Order totals are secured in USD.</p>
      </section>
    </div>`;
    document.querySelector('#add-car')?.addEventListener('click', () => {
      const items = cartItems();
      const existing = items.find(item => item.carId === car.id);
      if ((existing?.quantity || 0) >= car.availableStock) return toast('No more of this vehicle are currently available.');
      if (items.reduce((sum, item) => sum + item.quantity, 0) >= 10) return toast('You can reserve up to 10 vehicles per order.');
      if (existing) existing.quantity++;
      else items.push({ carId: car.id, quantity: 1 });
      saveCart(items);
      toast('Added to your saved cars.');
    });
  }

  async function cartPage() {
    const items = cartItems();
    const cars = await loadCars();
    const selected = items.map(item => ({ ...item, car: cars.find(car => car.id === item.carId) }));
    const subtotal = selected.reduce((sum, item) => sum + (item.car?.priceUsd || 0) * item.quantity, 0);
    const invalid = selected.some(item => !item.car || item.quantity > item.car.availableStock) ||
      items.reduce((sum, item) => sum + item.quantity, 0) > 10;
    app.innerHTML = `${pageHeading('Your selection', 'Saved cars', 'Your selected vehicles stay in your browser until you are ready to check out.')}
      ${selected.length ? `<div class="detail-grid"><div class="order-list">${selected.map(({ car, carId, quantity }) => `<article class="order-card button-row">
        ${car ? `<img src="${esc(car.imageUrl || '/assets/img/deal/2.jpg')}" alt="" style="width:125px;height:85px;object-fit:cover;border-radius:5px">` : ''}
        <div style="flex:1"><strong>${car ? `${esc(car.year)} ${esc(car.make)} ${esc(car.model)}` : 'Vehicle no longer available'}</strong><div class="muted">${car ? `${formatMoney(car.priceUsd)} each · ${car.availableStock} available` : 'Remove this vehicle to continue.'}</div>
          ${car && quantity > car.availableStock ? '<div class="error">Not enough stock. Update the quantity or remove this vehicle.</div>' : ''}</div>
        ${car && car.availableStock ? `<label class="cart-quantity">Quantity<input class="quantity-car" type="number" min="1" max="${Math.min(car.availableStock, 10)}" value="${quantity}" data-id="${esc(carId)}" aria-label="Quantity for ${esc(`${car.year} ${car.make} ${car.model}`)}"></label>` : ''}
        <button class="button-danger remove-car" data-id="${esc(carId)}">Remove</button>
      </article>`).join('')}</div>
      <aside class="panel"><h2>Estimated total</h2><div class="summary-row"><span>Subtotal</span><strong>${formatMoney(subtotal)}</strong></div>${invalid ? '<p class="error">Update your selection before checkout. Orders are limited to 10 vehicles.</p>' : ''}<p class="muted">Taxes or additional fees, if applicable, will be confirmed by the dealership.</p>${invalid ? '' : '<a class="button" href="/checkout">Continue to checkout</a>'}</aside></div>` :
        '<div class="panel empty-state"><h2>No cars saved yet</h2><p>Browse the inventory and add a vehicle to begin.</p><a class="button" href="/cars">Browse inventory</a></div>'}`;
    document.querySelectorAll('.remove-car').forEach(button => button.addEventListener('click', () => {
      saveCart(cartItems().filter(item => item.carId !== button.dataset.id));
      cartPage().catch(showError);
    }));
    document.querySelectorAll('.quantity-car').forEach(input => input.addEventListener('change', () => {
      const items = cartItems();
      const item = items.find(entry => entry.carId === input.dataset.id);
      const quantity = Number(input.value);
      const car = cars.find(entry => entry.id === input.dataset.id);
      if (!item || !car || !Number.isInteger(quantity) || quantity < 1 || quantity > car.availableStock ||
          items.reduce((sum, entry) => sum + (entry === item ? quantity : entry.quantity), 0) > 10) {
        input.value = item?.quantity || 1;
        return toast('Choose an available quantity; orders are limited to 10 vehicles.');
      }
      item.quantity = quantity;
      saveCart(items);
      cartPage().catch(showError);
    }));
  }

  async function loginPage(register = false) {
    app.innerHTML = `<div style="max-width:540px;margin:auto">${pageHeading(register ? 'Join TurqueX' : 'Welcome back', register ? 'Create your account' : 'Sign in')}
      <form id="auth-form" class="panel stack">
        ${register ? '<div class="field"><label for="name">Full name</label><input id="name" name="name" autocomplete="name" required minlength="2" maxlength="100"></div>' : ''}
        <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="password">Password${register ? ' (at least 12 characters)' : ''}</label><input id="password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="${register ? '12' : '1'}" maxlength="128" required></div>
        ${register ? '' : '<a href="/reset-password">Forgot your password?</a>'}
        <button class="button" type="submit">${register ? 'Create account' : 'Sign in'}</button>
        <p class="muted">${register ? 'Already have an account?' : 'New to <span class="notranslate" translate="no">TurqueX</span>?'} <a href="${register ? '/login' : '/register'}">${register ? 'Sign in' : 'Create an account'}</a></p>
        ${register ? '<p class="muted">Use a unique password of at least 12 characters and no more than 72 UTF-8 bytes.</p>' : ''}
      </form></div>`;
    document.querySelector('#auth-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const form = new FormData(event.currentTarget);
      button.disabled = true;
      try {
        const result = await api(register ? '/api/auth/register' : '/api/auth/login', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(form))
        });
        if (result.verificationRequired) {
          location.href = '/verify-email';
          return;
        }
        state.user = result.user;
        renderAuth();
        location.href = register && cartItems().length ? '/checkout' : state.user.role === 'admin' ? '/admin' : '/account';
      } catch (error) { showError(error); }
      finally { button.disabled = false; }
    });
  }

  async function verifyEmailPage() {
    let verification;
    try { verification = await api('/api/auth/verification'); }
    catch (error) {
      app.innerHTML = `<div class="panel empty-state"><h2>Start email verification</h2><p>${esc(error.message)}</p><a class="button" href="/login">Sign in</a> <a class="button button-secondary" href="/register">Create account</a></div>`;
      return;
    }
    const notice = verification.deliveryStatus === 'failed'
      ? 'We could not send your verification email. Please try requesting a new code in a minute.'
      : verification.deliveryStatus === 'sent'
        ? 'A verification code was sent. Check your inbox and spam folder.'
        : 'Enter the code sent when you registered, or request a new one.';
    app.innerHTML = `<div class="reset-flow">${pageHeading('One last step', 'Verify your email', 'Verify your email address before accessing your account.')}
      <section class="panel settings-panel"><p>Verification address: <strong>${esc(verification.email)}</strong></p>
        <p class="${verification.deliveryStatus === 'failed' ? 'error' : 'muted'}">${esc(notice)} Codes expire after 10 minutes and allow five incorrect attempts.</p>
        <form id="registration-verify-form" class="stack">
          <div class="field"><label for="registration-code">6-digit verification code</label><input id="registration-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
          <div><button type="submit">Verify email</button></div><div class="form-feedback" role="status"></div>
        </form>
        <div class="stack" style="margin-top:20px"><button type="button" class="settings-text-link" id="resend-registration-code">Request a new code</button><div id="resend-registration-feedback" class="form-feedback" role="status"></div><a class="settings-text-link" href="/login">Sign in with another account</a></div>
      </section></div>`;
    const form = document.querySelector('#registration-verify-form');
    const resend = document.querySelector('#resend-registration-code');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const feedback = form.querySelector('.form-feedback');
      button.disabled = true;
      resend.disabled = true;
      try {
        const result = await api('/api/auth/verification/confirm', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        state.user = result.user;
        renderAuth();
        location.href = cartItems().length ? '/checkout' : '/account';
      } catch (error) {
        feedback.className = 'form-feedback error';
        feedback.textContent = error.message;
      } finally { button.disabled = false; resend.disabled = false; }
    });
    resend.addEventListener('click', async () => {
      const feedback = document.querySelector('#resend-registration-feedback');
      resend.disabled = true;
      form.querySelector('button[type="submit"]').disabled = true;
      try {
        const result = await api('/api/auth/verification/resend', { method: 'POST', body: '{}' });
        feedback.className = 'form-feedback success';
        feedback.textContent = result.message;
      } catch (error) {
        feedback.className = 'form-feedback error';
        feedback.textContent = error.message;
      } finally { resend.disabled = false; form.querySelector('button[type="submit"]').disabled = false; }
    });
  }

  function bindSettingsForm(selector, url, method, onSuccess) {
    const form = document.querySelector(selector);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const feedback = form.querySelector('.form-feedback');
      button.disabled = true;
      const relatedButtons = document.querySelectorAll('.settings-nav-item, .restart-email, #reset-start-again');
      relatedButtons.forEach(item => { item.disabled = true; });
      try {
        const result = await api(url, { method, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        if (result.user) { state.user = result.user; renderAuth(); }
        feedback.className = 'form-feedback success';
        feedback.textContent = result.message || 'Changes saved.';
        if (onSuccess) onSuccess(result, form);
      } catch (error) {
        feedback.className = 'form-feedback error';
        feedback.textContent = error.message;
      } finally {
        button.disabled = false;
        relatedButtons.forEach(item => { item.disabled = false; });
      }
    });
  }

  function settingsPage() {
    if (!state.user) {
      app.innerHTML = `<div class="panel empty-state"><h2>Sign in to manage your account</h2><a class="button" href="/login">Sign in</a></div>`;
      return;
    }
    app.innerHTML = `<div class="account-settings">${pageHeading('Your TurqueX account', 'Account settings', 'Choose what you would like to update.')}
      <div class="account-settings-layout">
        <nav class="settings-nav" aria-label="Account settings sections">
          <button type="button" class="settings-nav-item active" data-settings-section="profile" aria-current="page"><i class="ri-user-line" aria-hidden="true"></i><span><strong>Profile</strong><small>Update your name</small></span><i class="ri-arrow-right-s-line" aria-hidden="true"></i></button>
          <button type="button" class="settings-nav-item" data-settings-section="password"><i class="ri-lock-line" aria-hidden="true"></i><span><strong>Password</strong><small>Keep your account secure</small></span><i class="ri-arrow-right-s-line" aria-hidden="true"></i></button>
          <button type="button" class="settings-nav-item" data-settings-section="email"><i class="ri-mail-line" aria-hidden="true"></i><span><strong>Email address</strong><small>Change and verify your email</small></span><i class="ri-arrow-right-s-line" aria-hidden="true"></i></button>
          <a class="settings-back" href="/account"><i class="ri-arrow-left-line" aria-hidden="true"></i> Back to my orders</a>
        </nav>
        <section class="panel settings-panel" id="settings-profile" aria-labelledby="profile-heading"><span class="eyebrow">Personal information</span><h2 id="profile-heading" tabindex="-1">Profile</h2><p class="muted">Update the name displayed on your account.</p>
          <form id="profile-form" class="stack"><div class="field"><label for="profile-name">Name</label><input id="profile-name" name="name" value="${esc(state.user.name)}" required minlength="2" maxlength="100" autocomplete="name"></div>
          <div><button type="submit">Save name</button></div><div class="form-feedback" role="status"></div></form>
        </section>
        <section class="panel settings-panel" id="settings-password" aria-labelledby="password-heading" hidden><span class="eyebrow">Account security</span><h2 id="password-heading" tabindex="-1">Change password</h2><p class="muted">Use at least 12 characters and no more than 72 UTF-8 bytes. Other signed-in sessions will be signed out.</p>
          <form id="password-form" class="stack"><div class="field"><label for="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="new-password">New password</label><input id="new-password" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="72" required></div>
          <div class="field"><label for="confirm-password">Re-enter new password</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="72" required></div>
          <div><button type="submit">Update password</button></div><div class="form-feedback" role="status"></div><a class="settings-text-link" href="/reset-password">Forgot your current password?</a></form>
        </section>
        <section class="panel settings-panel" id="settings-email" aria-labelledby="email-heading" hidden><span class="eyebrow">Account security</span><h2 id="email-heading" tabindex="-1">Change email address</h2>
          <p class="muted">Current email: <strong id="current-email">${esc(state.user.email)}</strong></p>
          <p class="muted">For your security, we'll verify your current and new email addresses. Each code expires after 10 minutes. If you leave this page, start the change again.</p>
          <ol class="settings-steps" aria-label="Email change progress">
            <li data-email-step="1" aria-current="step"><span>1</span> Details</li><li data-email-step="2"><span>2</span> Current email</li><li data-email-step="3"><span>3</span> New email</li>
          </ol>
          <form id="email-request-form" class="stack email-step"><h3>Enter your new email</h3><div class="field"><label for="new-email">New email address</label><input id="new-email" name="newEmail" type="email" autocomplete="email" maxlength="254" required></div>
          <div class="field"><label for="email-password">Current password</label><input id="email-password" name="currentPassword" type="password" autocomplete="current-password" required></div>
          <div><button type="submit">Send code to current email</button></div><div class="form-feedback" role="status"></div></form>
          <form id="old-email-form" class="stack email-step" hidden><h3>Verify your current email</h3><p class="muted">Enter the code sent to <strong id="old-email-destination"></strong>. Check your spam folder if you don't see it. Wait a minute before requesting another code.</p><div class="field"><label for="old-email-code">6-digit verification code</label><input id="old-email-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
          <div><button type="submit">Verify and continue</button></div><div class="form-feedback" role="status"></div><button type="button" class="settings-text-link restart-email">Start again or request a new code</button></form>
          <form id="new-email-form" class="stack email-step" hidden><h3>Verify your new email</h3><p class="muted">Enter the code sent to <strong id="new-email-destination"></strong>. Check your spam folder if you don't see it.</p><div class="field"><label for="new-email-code">6-digit verification code</label><input id="new-email-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
          <div><button type="submit">Confirm new email</button></div><div class="form-feedback" role="status"></div><button type="button" class="settings-text-link restart-email">Start again or request a new code</button></form>
          <div id="email-success" class="settings-complete" role="status" hidden><i class="ri-checkbox-circle-line" aria-hidden="true"></i><h3>Email address updated</h3><p class="muted">Your new email is ready to use. Other signed-in sessions have been signed out.</p><button type="button" class="button-secondary restart-email">Change email again</button></div>
        </section>
      </div></div>`;
    const showEmailStep = (step, focus = true) => {
      ['email-request-form', 'old-email-form', 'new-email-form', 'email-success'].forEach((id, index) => {
        document.getElementById(id).hidden = index + 1 !== step;
      });
      document.querySelectorAll('[data-email-step]').forEach(item => {
        const number = Number(item.dataset.emailStep);
        item.classList.toggle('completed', number < step);
        if (number === step) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      });
      if (focus && step < 4) document.querySelector(['#new-email', '#old-email-code', '#new-email-code'][step - 1]).focus();
    };
    const restartEmail = (focus = true) => {
      document.querySelectorAll('#settings-email form').forEach(form => {
        form.reset();
        form.querySelector('.form-feedback').textContent = '';
      });
      showEmailStep(1, focus);
    };
    document.querySelectorAll('[data-settings-section]').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('[data-settings-section]').forEach(item => {
        const selected = item === button;
        item.classList.toggle('active', selected);
        if (selected) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
        document.querySelector(`#settings-${item.dataset.settingsSection}`).hidden = !selected;
      });
      document.querySelector(`#settings-${button.dataset.settingsSection} h2`).focus();
    }));
    document.querySelectorAll('.restart-email').forEach(button => button.addEventListener('click', () => restartEmail()));
    bindSettingsForm('#profile-form', '/api/account/profile', 'PATCH', () => toast('Name updated.'));
    bindSettingsForm('#password-form', '/api/account/password', 'POST', (result, form) => {
      form.reset();
      restartEmail(false);
      form.querySelector('.form-feedback').textContent = 'Password updated. Other sessions have been signed out.';
    });
    bindSettingsForm('#email-request-form', '/api/account/email/request', 'POST', (result, form) => {
      form.elements.currentPassword.value = '';
      document.querySelector('#old-email-destination').textContent = state.user.email;
      document.querySelector('#new-email-destination').textContent = form.elements.newEmail.value.trim();
      showEmailStep(2);
    });
    bindSettingsForm('#old-email-form', '/api/account/email/verify-old', 'POST', (result, form) => {
      form.reset();
      showEmailStep(3);
    });
    bindSettingsForm('#new-email-form', '/api/account/email/verify-new', 'POST', (result, form) => {
      form.reset();
      document.querySelector('#current-email').textContent = result.user.email;
      showEmailStep(4);
      document.querySelector('#email-success h3').setAttribute('tabindex', '-1');
      document.querySelector('#email-success h3').focus();
    });
  }

  function resetPasswordPage() {
    app.innerHTML = `<div class="reset-flow">${pageHeading('Account security', 'Reset your password', 'Follow the steps below to get back into your account.')}
      <section class="panel settings-panel">
      <ol class="settings-steps" aria-label="Password reset progress"><li data-reset-step="1" aria-current="step"><span>1</span> Request code</li><li data-reset-step="2"><span>2</span> Set password</li></ol>
      <div id="reset-request-step"><h2>Request a code</h2>
      <p class="muted">If an account exists and email delivery is available, a code will be sent. Codes expire after 10 minutes.</p>
      <form id="reset-request-form" class="stack"><div class="field"><label for="reset-request-email">Email address</label><input id="reset-request-email" name="email" type="email" autocomplete="email" maxlength="254" required></div>
      <div><button type="submit">Send reset code</button></div><div class="form-feedback" role="status"></div><a class="settings-text-link" href="/login">Back to sign in</a></form></div>
      <div id="reset-confirm-step" hidden><h2>Set a new password</h2><p class="muted">If an account exists and email delivery is available, a code will be sent. Check your inbox and spam folder; wait a minute before requesting another code. Use a password of at least 12 characters and no more than 72 UTF-8 bytes.</p>
      <form id="reset-confirm-form" class="stack"><div class="field"><label for="reset-email">Email address</label><input id="reset-email" name="email" type="email" autocomplete="email" maxlength="254" required></div>
      <div class="field"><label for="reset-code">Verification code</label><input id="reset-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
      <div class="field"><label for="reset-new-password">New password</label><input id="reset-new-password" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="72" required></div>
      <div class="field"><label for="reset-confirm-password">Re-enter new password</label><input id="reset-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="72" required></div>
      <div><button type="submit">Reset password</button></div><div class="form-feedback" role="status"></div><button type="button" class="settings-text-link" id="reset-start-again">Start again or request a new code</button></form></div>
      <div id="reset-success" class="settings-complete" role="status" hidden><i class="ri-checkbox-circle-line" aria-hidden="true"></i><h2 tabindex="-1">Password reset</h2><p class="muted">Your password has been updated. Sign in with your new password.</p><a class="button" href="/login">Sign in</a></div>
      </section></div>`;
    const showResetStep = step => {
      ['reset-request-step', 'reset-confirm-step', 'reset-success'].forEach((id, index) => {
        document.getElementById(id).hidden = index + 1 !== step;
      });
      document.querySelectorAll('[data-reset-step]').forEach(item => {
        const number = Number(item.dataset.resetStep);
        item.classList.toggle('completed', number < step);
        if (number === step) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      });
      document.querySelector(['#reset-request-email', '#reset-code', '#reset-success h2'][step - 1]).focus();
    };
    document.querySelector('#reset-start-again').addEventListener('click', () => {
      document.querySelector('#reset-confirm-form .form-feedback').textContent = '';
      document.querySelector('#reset-request-form .form-feedback').textContent = '';
      showResetStep(1);
    });
    bindSettingsForm('#reset-request-form', '/api/auth/password-reset/request', 'POST', (result, form) => {
      document.querySelector('#reset-email').value = form.elements.email.value;
      showResetStep(2);
    });
    bindSettingsForm('#reset-confirm-form', '/api/auth/password-reset/confirm', 'POST', (result, form) => {
      form.reset();
      state.user = null;
      renderAuth();
      showResetStep(3);
    });
  }

  async function checkoutPage() {
    if (!state.user) {
      app.innerHTML = `<div class="panel empty-state"><h2>Sign in to checkout</h2><p>Create an account or sign in before placing an order.</p><div class="button-row" style="justify-content:center"><a class="button" href="/login">Sign in</a><a class="button button-secondary" href="/register">Create account</a></div></div>`;
      return;
    }
    const pendingCryptoOrder = sessionStorage.getItem(pendingCryptoOrderKey);
    if (pendingCryptoOrder) {
      app.innerHTML = '<section id="order-result" class="panel" aria-live="polite">Loading your existing order...</section>';
      try {
        const result = await api(`/api/orders/${encodeURIComponent(pendingCryptoOrder)}/crypto-box`);
        await showOrderResult(document.querySelector('#order-result'), result);
      } catch (error) {
        app.innerHTML = `<section class="panel"><h1>Could not reopen the payment box</h1><p class="error">${esc(error.message)}</p>
          <p>Check My orders before placing another order. Do not send funds after the payment deadline.</p>
          <div class="button-row"><button id="retry-crypto" type="button">Try again</button><a class="button button-secondary" href="/account">My orders</a><button id="new-checkout" type="button">Start a new checkout</button></div></section>`;
        document.querySelector('#retry-crypto').addEventListener('click', checkoutPage);
        document.querySelector('#new-checkout').addEventListener('click', () => {
          sessionStorage.removeItem(pendingCryptoOrderKey);
          checkoutPage();
        });
      }
      return;
    }
    const items = cartItems();
    const cars = await loadCars();
    const selected = items.map(item => ({ ...item, car: cars.find(car => car.id === item.carId) }));
    if (!selected.length || selected.some(item => !item.car || item.quantity > item.car.availableStock) ||
        items.reduce((sum, item) => sum + item.quantity, 0) > 10) {
      app.innerHTML = `<div class="panel empty-state"><h2>Update your saved cars before checkout</h2><p>Some vehicles may no longer be available, or your selection exceeds the 10-vehicle limit.</p><a class="button" href="/cart">Review saved cars</a></div>`;
      return;
    }
    const subtotalUsd = selected.reduce((sum, item) => sum + Math.round(item.car.priceUsd * item.quantity * 100), 0) / 100;
    const settings = await api('/api/payment-settings');
    app.innerHTML = `${pageHeading('Secure reservation', 'Checkout', 'Complete your contact details and choose how to pay.')}
      <div class="detail-grid">
        <form id="checkout-form" class="stack">
          <section class="panel stack"><h2>Contact and delivery details</h2>
            <div class="form-grid">
              <div class="field field-full"><label for="buyer-name">Full name</label><input id="buyer-name" name="name" required maxlength="200" value="${esc(state.user.name)}"></div>
              <div class="field"><label for="buyer-email">Email</label><input id="buyer-email" name="email" type="email" required maxlength="200" value="${esc(state.user.email)}"></div>
              <div class="field"><label for="buyer-phone">Phone</label><input id="buyer-phone" name="phone" type="tel" required maxlength="40"></div>
              <div class="field field-full"><label for="buyer-address">Street address</label><input id="buyer-address" name="address" required maxlength="200"></div>
              <div class="field"><label for="buyer-city">City</label><input id="buyer-city" name="city" required maxlength="100"></div>
              <div class="field"><label for="buyer-country">Country</label><input id="buyer-country" name="country" required maxlength="100"></div>
            </div>
          </section>
          <section class="panel stack"><h2>Payment method</h2>
            <label class="payment-option"><input type="radio" name="paymentMethod" value="gourl" ${settings.cryptoEnabled ? 'checked' : 'disabled'}>
              <span><span class="recommended">Recommended · Crypto</span><br><strong>Pay with ${esc(settings.cryptoCoin.toUpperCase())} via GoUrl</strong><br><span class="muted">GoUrl will display your payment QR code and address. Send only ${esc(settings.cryptoCoin.toUpperCase())} to this address.</span>
              ${settings.cryptoEnabled ? '' : '<br><span class="error">Crypto checkout is currently unavailable.</span>'}</span>
            </label>
            <label class="payment-option"><input type="radio" name="paymentMethod" value="bank" ${!settings.cryptoEnabled && settings.bankTransferEnabled ? 'checked' : ''} ${settings.bankTransferEnabled ? '' : 'disabled'}>
              <span><strong>Bank transfer</strong><br><span class="muted">The dealership will assign bank details to your order. Your one-hour payment window begins after assignment. Check My orders for updates.</span></span>
            </label>
          </section>
          <section class="panel stack"><h2>Promo codes</h2><p class="muted">Apply up to two codes. Brand-specific offers apply only to eligible vehicles.</p><div class="button-row"><input id="promo-code" aria-label="Promo code" placeholder="Enter code" maxlength="30"><button id="apply-promo" class="button button-secondary" type="button">Apply</button></div><div id="promo-result" role="status"></div><div id="applied-promos" class="stack"></div></section>
          <button class="button" type="submit">Place order and reserve car</button>
        </form>
        <aside class="panel"><h2>Order summary</h2>${selected.map(({car, quantity}) => `<div class="summary-row"><span>${esc(car.year)} ${esc(car.make)} ${esc(car.model)} × ${quantity}</span><strong>${formatMoney(car.priceUsd * quantity)}</strong></div>`).join('')}
          <hr><div class="summary-row"><span>Subtotal</span><strong>${formatMoney(subtotalUsd)}</strong></div>
          <div class="summary-row"><span>Promo discount</span><strong id="discount-value">${formatMoney(0)}</strong></div>
          <div class="summary-row"><strong>Estimated total</strong><strong id="checkout-total">${formatMoney(subtotalUsd)}</strong></div>
          <p class="muted">Subtotal: $${subtotalUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD before any promo code. Display prices are estimates; a bank payment amount is converted and locked when an account is assigned.</p>
        </aside>
      </div>
      <section id="order-result" class="panel" hidden style="margin-top:24px"></section>`;
    let activePromos = [];
    let orderInFlight = false;
    const updatePromos = async codes => {
      if (orderInFlight) return;
      const result = document.querySelector('#promo-result');
      const applyButton = document.querySelector('#apply-promo');
      const orderButton = document.querySelector('#checkout-form button[type="submit"]');
      applyButton.disabled = true;
      orderButton.disabled = true;
      document.querySelectorAll('.remove-promo').forEach(button => { button.disabled = true; });
      try {
        const data = codes.length
          ? await api('/api/promos/validate', { method: 'POST', body: JSON.stringify({ codes, items }) })
          : { promos: [], discountUsd: 0, totalUsd: subtotalUsd };
        activePromos = data.promos.map(promo => promo.code);
        if (activePromos.length) localStorage.setItem(promoKey, JSON.stringify(activePromos));
        else localStorage.removeItem(promoKey);
        document.querySelector('#discount-value').textContent = formatMoney(data.discountUsd);
        document.querySelector('#checkout-total').textContent = formatMoney(data.totalUsd);
        const list = document.querySelector('#applied-promos');
        list.innerHTML = data.promos.map(promo => `<div><strong>${esc(promo.code)}</strong> · ${promo.kind === 'percent' ? `${esc(promo.amount)}% off` : `${esc(formatMoney(promo.amount))} off`} · You save ${esc(formatMoney(promo.discountUsd))}${promo.brands.length ? ` · ${esc(promo.brands.join(', '))}` : ''}${promo.description ? `<br><span class="muted">${esc(promo.description)}</span>` : ''} <button type="button" class="settings-text-link remove-promo" data-code="${esc(promo.code)}">Remove</button></div>`).join('');
        list.querySelectorAll('.remove-promo').forEach(button => button.addEventListener('click', () => updatePromos(activePromos.filter(code => code !== button.dataset.code))));
        document.querySelector('#promo-code').value = '';
        result.className = 'success';
        result.textContent = data.promos.length ? 'Promo codes applied.' : '';
      } catch (error) {
        result.className = 'error';
        result.textContent = error.message;
      } finally {
        applyButton.disabled = false;
        orderButton.disabled = false;
        document.querySelectorAll('.remove-promo').forEach(button => { button.disabled = false; });
      }
    };
    document.querySelector('#apply-promo').addEventListener('click', () => {
      const code = document.querySelector('#promo-code').value.trim();
      if (!code) { document.querySelector('#promo-result').textContent = 'Enter a promo code.'; return; }
      updatePromos([...activePromos, code]);
    });
    const savedPromo = localStorage.getItem(promoKey);
    if (savedPromo) {
      let savedCodes;
      try { savedCodes = JSON.parse(savedPromo); }
      catch { savedCodes = [savedPromo]; }
      if (Array.isArray(savedCodes) && savedCodes.length) await updatePromos(savedCodes);
    }
    document.querySelector('#checkout-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const paymentMethod = form.get('paymentMethod');
      if (!paymentMethod) return toast('Choose a payment method that is available.');
      const button = event.currentTarget.querySelector('button[type="submit"]');
      button.disabled = true;
      orderInFlight = true;
      document.querySelector('#apply-promo').disabled = true;
      document.querySelectorAll('.remove-promo').forEach(item => { item.disabled = true; });
      try {
        const result = await api('/api/orders', {
          method: 'POST',
          body: JSON.stringify({
            items,
            paymentMethod,
            currency: state.currency,
            promoCodes: activePromos,
            buyer: Object.fromEntries([...form.entries()].filter(([key]) => ['name', 'email', 'phone', 'address', 'city', 'country'].includes(key)))
          })
        });
        saveCart([]);
        localStorage.removeItem(promoKey);
        renderPromotion().catch(error => console.error('Could not refresh the featured promotion:', error));
        const order = result.order;
        const box = document.querySelector('#order-result');
        box.hidden = false;
        if (paymentMethod === 'gourl') sessionStorage.setItem(pendingCryptoOrderKey, order.id);
        await showOrderResult(box, result);
      } catch (error) {
        showError(error);
        orderInFlight = false;
        button.disabled = false;
        document.querySelector('#apply-promo').disabled = false;
        document.querySelectorAll('.remove-promo').forEach(item => { item.disabled = false; });
      }
    });
  }

  async function showOrderResult(container, { order, cryptoBox }) {
    const isCrypto = order.paymentMethod === 'gourl';
    container.innerHTML = `<div class="success"><strong>Order ${esc(order.id)}.</strong> ${isCrypto ? 'Please complete your payment before the one-hour reservation expires.' : 'Your vehicle is reserved while the dealership assigns bank details. Check My orders for updates.'}</div>
      <div class="summary-row"><span>Order status</span><strong class="status ${esc(order.status)}">${esc(order.status.replaceAll('_', ' '))}</strong></div>
      <div class="summary-row"><span>Total</span><strong>$${Number(order.totalUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })} USD</strong></div>
      ${trackingMarkup(order.tracking)}
      ${isCrypto ? '<div class="summary-row"><span>Payment window</span><strong id="order-countdown" class="timer"></strong></div><h3>Complete crypto payment</h3><p class="muted">Scan the QR code or copy the payment address shown by GoUrl. If the box shows an error or does not load, contact the dealership and do not send payment.</p><div id="crypto-box" class="crypto-box">Loading GoUrl payment box...</div>' : '<p class="muted">The payment timer starts when bank details are assigned.</p>'}
      <a class="button button-secondary" href="/account">View order status</a>`;
    bindTrackingControls(container);
    if (order.expiresAt) startCountdown(order.expiresAt, '#order-countdown');
    if (isCrypto) await renderGoUrl(container.querySelector('#crypto-box'), cryptoBox, order.expiresAt);
  }

  function bankPaymentMarkup(payment) {
    const details = payment?.bankDetails;
    if (!details?.accountName || !details?.bankName || !details?.accountNumber) {
      return '<div class="notice">The dealership is assigning bank-transfer details. Do not send payment until they appear here.</div>';
    }
    return `<h3>Bank transfer details</h3><div class="panel">
      ${payment.amount != null ? `<div class="summary-row"><span>Exact amount</span><strong>${esc(new Intl.NumberFormat(undefined, { style: 'currency', currency: payment.currency }).format(payment.amount))} ${esc(payment.currency)}</strong></div>` : ''}
      <div class="summary-row"><span>Account name</span><strong>${esc(details.accountName)}</strong></div>
      <div class="summary-row"><span>Bank</span><strong>${esc(details.bankName)}</strong></div>
      <div class="summary-row"><span>Account number</span><strong>${esc(details.accountNumber)}</strong></div>
      ${details.routingNumber ? `<div class="summary-row"><span>Routing / sort code</span><strong>${esc(details.routingNumber)}</strong></div>` : ''}
      ${details.swiftCode ? `<div class="summary-row"><span>SWIFT / BIC</span><strong>${esc(details.swiftCode)}</strong></div>` : ''}
      ${details.instructions ? `<p class="muted">${esc(details.instructions)}</p>` : ''}
      ${payment.rate ? `<p class="muted">Converted from USD at ${esc(payment.rate)} ${esc(payment.currency)} per USD. Rate updated: ${esc(payment.rateUpdatedAt || 'not provided')}.</p>` : ''}
      <p class="muted">Use your order number as the transfer reference. The dealership must verify your transfer before it is marked paid.</p></div>`;
  }

  async function renderGoUrl(container, box, expiresAt) {
    try {
      if (!box) throw new Error('GoUrl payment details are missing.');
      if (typeof window.cryptobox_show !== 'function') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          const timeout = setTimeout(() => {
            script.remove();
            reject(new Error('GoUrl script timed out.'));
          }, 10000);
          script.onload = () => { clearTimeout(timeout); resolve(); };
          script.onerror = () => { clearTimeout(timeout); reject(new Error('GoUrl script could not be loaded.')); };
          script.src = 'https://cdn.jsdelivr.net/gh/cryptoapi/Payment-Gateway@85d9a27916a2b721d5143b9ed499411246274077/js/_source/cryptobox.js';
          document.head.appendChild(script);
        });
      }
      if (typeof window.cryptobox_show !== 'function') throw new Error('GoUrl script did not provide the payment interface.');
      if (new Date(expiresAt).getTime() <= Date.now()) {
        container.textContent = 'The payment window has expired. Do not send payment; contact the dealership.';
        return;
      }
      const iframe = document.createElement('iframe');
      iframe.id = box.iframeId;
      iframe.title = 'GoUrl crypto payment';
      iframe.width = box.width;
      iframe.height = box.height;
      iframe.addEventListener('error', () => {
        if (container.contains(iframe)) {
          container.textContent = 'The GoUrl payment box could not load. Contact the dealership; do not send funds to an unverified address.';
        }
      });
      container.replaceChildren(iframe);
      const params = [
        box.boxId, box.coinName, box.publicKey, box.amount, box.amountUsd, box.period,
        box.language, box.iframeId, box.userId, box.userFormat, box.orderId,
        box.cookieName, box.webdevKey, box.version, box.hash, box.width, box.height
      ];
      window.cryptobox_show(...params);
      if (!iframe.getAttribute('src')) throw new Error('GoUrl did not initialize the payment box.');
    } catch (error) {
      console.error('GoUrl payment interface failed:', error);
      if (new Date(expiresAt).getTime() > Date.now()) {
        container.innerHTML = '<div class="error">The GoUrl payment interface could not load. Contact the dealership; do not send funds to an unverified address.</div>';
      }
    }
  }

  function startCountdown(expiresAt, selector) {
    clearInterval(state.timer);
    const element = document.querySelector(selector);
    const tick = () => {
      const left = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      const minutes = Math.floor(left / 60000);
      const seconds = Math.floor((left % 60000) / 1000);
      element.textContent = left ? `${minutes}:${String(seconds).padStart(2, '0')} remaining` : 'Expired';
      if (!left) {
        clearInterval(state.timer);
        const box = document.querySelector('#crypto-box');
        if (box) box.textContent = 'The payment window has expired. Do not send payment; contact the dealership.';
      }
    };
    tick();
    if (new Date(expiresAt).getTime() > Date.now()) state.timer = setInterval(tick, 1000);
  }

  async function accountPage() {
    if (!state.user) {
      app.innerHTML = `<div class="panel empty-state"><h2>Sign in to view your orders</h2><a class="button" href="/login">Sign in</a></div>`;
      return;
    }
    const { orders } = await api('/api/orders');
    app.innerHTML = `${pageHeading('Your TurqueX account', 'My orders', 'Review order details and payment deadlines.')}
      <p><a class="button button-secondary" href="/settings">Account settings</a></p><div id="account-orders" class="order-list">${orders.map(order => `<article class="order-card" data-order-id="${esc(order.id)}"></article>`).join('') || '<div class="panel empty-state">No orders yet. <a href="/cars">Browse vehicles</a></div>'}</div>`;
    const versions = new Map();
    const busy = new Set();
    let revision = 0;
    const drawOrder = order => {
      const card = document.querySelector(`[data-order-id="${CSS.escape(order.id)}"]`);
      if (!card || busy.has(order.id)) return;
      const version = JSON.stringify(order);
      if (versions.get(order.id) === version) return;
      versions.set(order.id, version);
      card.innerHTML = `<div class="button-row" style="justify-content:space-between"><strong>Order ${esc(order.id)}</strong><span class="status ${esc(order.status)}">${esc(order.status.replaceAll('_', ' '))}</span></div>
        <p class="muted">${order.items.map(item => `${esc(item.year)} ${esc(item.make)} ${esc(item.model)} × ${item.quantity}`).join(' · ')}</p>
        <div class="summary-row"><span>Total</span><strong>$${Number(order.totalUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })} USD</strong></div>
        <div class="summary-row"><span>Method</span><span>${order.paymentMethod === 'gourl' ? `GoUrl · ${esc(order.paymentDetails?.cryptoCoin || 'Crypto')}` : 'Bank transfer'}</span></div>
        <div class="summary-row"><span>Created</span><span>${esc(formatDate(order.createdAt))}</span></div>
        ${trackingMarkup(order.tracking)}
        ${order.status === 'awaiting_payment' && order.expiresAt ? `<div class="summary-row"><span>Pay before ${esc(formatDate(order.expiresAt))}</span><strong class="timer" data-deadline="${esc(order.expiresAt)}"></strong></div>` : ''}
        ${order.paymentMethod === 'gourl' && order.status === 'awaiting_payment' ? '<p class="muted">Do not send payment after the deadline. Contact the dealership if the GoUrl box shows an error.</p><button class="open-crypto" type="button">Open crypto payment box</button><div class="crypto-box" hidden></div>' : ''}
        ${order.paymentMethod === 'bank' && ['awaiting_bank_assignment', 'awaiting_payment', 'payment_claimed', 'proof_submitted'].includes(order.status) ? bankPaymentMarkup(order.paymentDetails) : ''}
        ${order.paymentMethod === 'bank' && order.status === 'awaiting_payment' ? '<p class="muted">After transferring, report your payment before the timer expires. The dealership must manually verify it.</p><button class="claim-payment" type="button">I have made payment</button>' : ''}
        ${order.status === 'payment_claimed' ? `<div class="notice proof-processing" data-available-at="${esc(order.proofAvailableAt)}">Processing your request. Proof upload opens in <strong class="proof-wait"></strong>. No automatic bank verification is performed.</div>
          <form class="proof-upload" hidden><div><span class="eyebrow">Manual verification</span><h3>Submit payment proof</h3><p class="muted">Payment has not been verified. Upload a receipt for the dealership to review.</p></div>
            <label class="proof-picker"><input type="file" name="proof" accept="image/jpeg,image/png,application/pdf" required aria-describedby="proof-file-help-${esc(order.id)}">
              <span class="proof-icon"><i class="ri-upload-cloud-2-line" aria-hidden="true"></i></span><span class="proof-picker-copy"><strong>Choose your payment receipt</strong><small id="proof-file-help-${esc(order.id)}">JPEG, PNG or PDF · maximum 5 MB</small><span class="proof-filename" aria-live="polite">No file selected</span></span></label>
            <button type="submit" class="proof-submit"><i class="ri-shield-check-line" aria-hidden="true"></i> Submit proof for review</button></form>` : ''}
        ${order.status === 'proof_submitted' ? '<div class="notice">Payment proof received. The dealership will review it; payment is not yet confirmed.</div>' : ''}
        <div class="order-feedback" role="status"></div>`;
      bindTrackingControls(card);
      card.querySelector('.open-crypto')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        const container = card.querySelector('.crypto-box');
        const feedback = card.querySelector('.order-feedback');
        button.disabled = true;
        busy.add(order.id);
        revision++;
        container.hidden = false;
        container.textContent = 'Loading GoUrl payment box...';
        feedback.textContent = '';
        try {
          const result = await api(`/api/orders/${encodeURIComponent(order.id)}/crypto-box`);
          await renderGoUrl(container, result.cryptoBox, result.order.expiresAt);
        } catch (error) {
          container.hidden = true;
          feedback.textContent = error.message;
        } finally {
          busy.delete(order.id);
          if (new Date(order.expiresAt).getTime() > Date.now()) button.disabled = false;
        }
      });
      card.querySelector('.proof-upload input[type="file"]')?.addEventListener('change', event => {
        const file = event.currentTarget.files[0];
        card.querySelector('.proof-filename').textContent = file ? file.name : 'No file selected';
        card.querySelector('.order-feedback').textContent = '';
      });
      card.querySelector('.claim-payment')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        revision++;
        busy.add(order.id);
        try {
          await api(`/api/orders/${encodeURIComponent(order.id)}/payment-claim`, { method: 'POST', body: '{}' });
          const result = await api(`/api/orders/${encodeURIComponent(order.id)}`);
          busy.delete(order.id);
          drawOrder(result.order);
          tick();
        } catch (error) {
          busy.delete(order.id);
          button.disabled = false;
          card.querySelector('.order-feedback').textContent = error.message;
        }
      });
      card.querySelector('.proof-upload')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const file = form.elements.proof.files[0];
        const feedback = card.querySelector('.order-feedback');
        if (!file || file.size > 5 * 1024 * 1024) {
          feedback.textContent = 'Choose a JPEG, PNG or PDF file no larger than 5 MB.';
          return;
        }
        form.querySelector('button').disabled = true;
        revision++;
        busy.add(order.id);
        try {
          const response = await fetch(`/api/orders/${encodeURIComponent(order.id)}/payment-proof`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Proof-Type': file.type, 'X-CSRF-Token': state.token },
            body: file
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || `Upload failed (${response.status}).`);
          const updated = await api(`/api/orders/${encodeURIComponent(order.id)}`);
          busy.delete(order.id);
          drawOrder(updated.order);
        } catch (error) {
          busy.delete(order.id);
          form.querySelector('button').disabled = false;
          feedback.textContent = error.message;
        }
      });
    };
    const tick = () => {
      document.querySelectorAll('[data-deadline]').forEach(element => {
        const seconds = Math.max(0, Math.ceil((new Date(element.dataset.deadline).getTime() - Date.now()) / 1000));
        element.textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining` : 'Expired';
        if (!seconds) {
          const card = element.closest('.order-card');
          const button = card.querySelector('.open-crypto');
          if (button) button.disabled = true;
          const box = card.querySelector('.crypto-box');
          if (box && !box.hidden) box.textContent = 'The payment window has expired. Do not send payment; contact the dealership.';
        }
      });
      document.querySelectorAll('.proof-processing').forEach(element => {
        const seconds = Math.max(0, Math.ceil((new Date(element.dataset.availableAt).getTime() - Date.now()) / 1000));
        element.querySelector('.proof-wait').textContent = `${seconds} seconds`;
        element.hidden = seconds === 0;
        element.parentElement.querySelector('.proof-upload').hidden = seconds !== 0;
      });
    };
    orders.forEach(drawOrder);
    tick();
    let lastRefresh = Date.now();
    let refreshing = false;
    state.timer = setInterval(async () => {
      tick();
      if (refreshing || Date.now() - lastRefresh < 10000) return;
      refreshing = true;
      lastRefresh = Date.now();
      const refreshRevision = revision;
      try {
        const updated = await api('/api/orders');
        if (revision === refreshRevision) updated.orders.forEach(drawOrder);
      } catch (error) {
        console.error('Could not refresh order statuses:', error);
        toast('Could not refresh order statuses. Check your connection.');
      } finally { refreshing = false; }
    }, 1000);
  }

  async function trackingPage() {
    app.innerHTML = `${pageHeading('Your journey', 'Track your order', 'Enter your private tracking code to see shipment updates.')}
      <div class="tracking-layout"><section class="panel"><h2>FIND YOUR ORDER</h2>
        <p class="muted">Your code is available in My orders and in your tracking email. Anyone with the code can view shipment progress.</p>
        <form id="tracking-form" class="stack"><div class="field"><label for="tracking-code">Tracking code</label>
          <input id="tracking-code" name="code" required autocomplete="off" spellcheck="false" placeholder="TX-..." maxlength="35"></div>
          <div><button type="submit">View shipment</button></div></form></section>
        <section id="tracking-result" class="panel" aria-live="polite"><h2>SHIPMENT PROGRESS</h2><p class="muted">Enter a tracking code to begin.</p></section></div>`;
    const form = document.querySelector('#tracking-form');
    const result = document.querySelector('#tracking-result');
    const loadTracking = async code => {
      const normalized = code.trim().toUpperCase();
      if (!/^TX-[A-F0-9]{32}$/.test(normalized)) {
        result.innerHTML = '<h2>SHIPMENT PROGRESS</h2><p class="error">Enter a valid tracking code.</p>';
        return;
      }
      form.elements.code.value = normalized;
      history.replaceState(null, '', `/track#${encodeURIComponent(normalized)}`);
      result.innerHTML = '<h2>SHIPMENT PROGRESS</h2><p class="muted">Loading tracking details...</p>';
      try {
        const tracking = await api('/api/tracking', { headers: { 'X-Tracking-Code': normalized } });
        const labels = {
          ...shipmentLabels,
          order_received: 'Order received',
          awaiting_shipment: 'Awaiting shipment update',
          cancelled: 'Order cancelled',
          expired: 'Order expired'
        };
        result.innerHTML = `<span class="eyebrow">Current status</span><h2>${esc(labels[tracking.status] || tracking.status)}</h2>
          <p class="muted">Order received ${esc(formatDate(tracking.createdAt))}. Shipment stages are updated by the dealership.</p>
          <ol class="tracking-steps">${Object.entries(shipmentLabels).map(([key, label]) => `<li class="${tracking.status === key ? 'current' : ''}" ${tracking.status === key ? 'aria-current="step"' : ''}><span class="tracking-step-dot"></span>${esc(label)}</li>`).join('')}</ol>
          <h3>Update history</h3>${tracking.events.length ? `<ul class="tracking-history">${tracking.events.slice().reverse().map(event => `<li><strong>${esc(shipmentLabels[event.status] || event.status)}</strong><span>${esc(formatDate(event.createdAt))}</span></li>`).join('')}</ul>` : '<p class="muted">No shipment updates have been recorded yet.</p>'}
          <button type="button" class="button-secondary refresh-tracking">Refresh status</button>`;
        result.querySelector('.refresh-tracking').addEventListener('click', () => loadTracking(normalized));
      } catch (error) {
        result.innerHTML = `<h2>SHIPMENT PROGRESS</h2><p class="error">${esc(error.message)}</p>`;
      }
    };
    form.addEventListener('submit', event => {
      event.preventDefault();
      loadTracking(form.elements.code.value);
    });
    if (location.hash.length > 1) {
      form.elements.code.value = location.hash.slice(1);
      await loadTracking(form.elements.code.value);
    }
  }

  function contactInfo() {
    if (!state.contact) return '<p class="muted">Contact details are temporarily unavailable.</p>';
    const { phone, address, hours } = state.contact;
    return `<div class="contact-detail"><i class="ri-mail-line" aria-hidden="true"></i><div><h3>Email</h3><a href="mailto:sales@turquex.com">sales@turquex.com</a></div></div>
      <div class="contact-detail"><i class="ri-phone-line" aria-hidden="true"></i><div><h3>Phone</h3>${phone ? `<a href="tel:${esc(phone)}">${esc(phone)}</a>` : '<span class="muted"><a href="/book-call">Request a call</a>.</span>'}</div></div>
      ${address ? `<div class="contact-detail"><i class="ri-map-pin-line" aria-hidden="true"></i><div><h3>Address</h3><span class="muted notranslate" translate="no">${esc(address)}</span></div></div>` : ''}
      ${hours ? `<div class="contact-detail"><i class="ri-time-line" aria-hidden="true"></i><div><h3>Hours</h3><span class="muted">${esc(hours)}</span></div></div>` : ''}`;
  }

  function contactPage() {
    app.innerHTML = `${pageHeading('Get in touch', 'Contact us', 'Have a question about a vehicle or your order? Send us a message.')}
      <div class="contact-layout"><section class="panel contact-info"><span class="section-badge">Let’s connect</span><h2>CONTACT <span class="accent">INFORMATION</span></h2><div class="section-line"></div><p class="muted">Reach out to the <span class="notranslate" translate="no">TurqueX</span> team, or request a call at your preferred time.</p>${contactInfo()}<a class="button button-secondary" href="/book-call">Request a call</a></section>
      <section class="panel"><h2>SEND US A MESSAGE</h2><p class="muted">Our team is here to help.</p>
        <form id="contact-form" class="form-grid">
          <div class="field"><label for="contact-name">Name</label><input id="contact-name" name="name" required minlength="2" maxlength="100" autocomplete="name"></div>
          <div class="field"><label for="contact-email">Email</label><input id="contact-email" name="email" type="email" required maxlength="254" autocomplete="email"></div>
          <div class="field"><label for="contact-phone">Phone</label><input id="contact-phone" name="phone" type="tel" required maxlength="30" autocomplete="tel"></div>
          <div class="field"><label for="contact-subject">Inquiry type</label><select id="contact-subject" name="subject"><option>Vehicle inquiry</option><option>Order inquiry</option><option>General question</option></select></div>
          <div class="field field-full"><label for="contact-message">Message</label><textarea id="contact-message" name="message" rows="6" required minlength="5" maxlength="4000"></textarea></div>
          <div class="field-full"><button type="submit">Send message</button><div class="form-feedback" role="status"></div></div>
        </form></section></div>`;
    const form = document.querySelector('#contact-form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      const feedback = form.querySelector('.form-feedback');
      button.disabled = true;
      try {
        const result = await api('/api/contact-messages', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        form.reset();
        feedback.className = `form-feedback ${result.confirmationStatus === 'sent' ? 'success' : 'notice'}`;
        feedback.textContent = result.confirmationStatus === 'sent'
          ? 'Your message has been received. A confirmation email was accepted by the mail server.'
          : 'Your message has been received, but the confirmation email could not be sent.';
      } catch (error) {
        feedback.className = 'form-feedback error';
        feedback.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    if (location.hash === '#contact-form') form.scrollIntoView({ block: 'start' });
  }

  async function bookCallPage() {
    const id = new URLSearchParams(location.search).get('id');
    const trackingToken = location.hash.slice(1);
    if (id || trackingToken) {
      if (!id || !/^[a-f0-9]{64}$/.test(trackingToken)) throw new Error('This call request link is incomplete.');
      const request = await api(`/api/call-requests/${encodeURIComponent(id)}`, { headers: { 'X-Request-Token': trackingToken } });
      app.innerHTML = `${pageHeading('Sales call', 'Call request status', 'This private link lets you check the status of your request.')}
        <div class="panel"><h2>Status: ${esc(request.status)}</h2><p>Preferred time: ${esc(formatDate(request.preferredAt))} (your current time zone)</p><p class="muted">${request.status === 'requested' ? 'Your request is pending. This is not a confirmed appointment.' : request.status === 'confirmed' ? 'The sales team has confirmed your requested time.' : 'The sales team could not confirm this time. Please submit another request.'}</p><a class="button" href="/book-call">Request another call</a></div>`;
      return;
    }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    app.innerHTML = `${pageHeading('Talk to our team', 'Book a sales call', 'Choose your preferred time. Our team will review your request; it is not confirmed until the status changes.')}
      <div class="contact-layout"><section class="panel contact-info"><span class="section-badge">Personal assistance</span><h2>LET’S <span class="accent">TALK CARS</span></h2><div class="section-line"></div><p class="muted">Share your contact details and a preferred time. Save the private status link after submitting to check for confirmation.</p><p class="muted">Our calendar uses New York time. Times are also shown in your time zone: <strong>${esc(timezone || 'Unavailable')}</strong>.</p><a href="/contact">Prefer to send a message?</a></section>
      <section class="panel"><h2>REQUEST A CALL</h2><form id="call-form" class="form-grid">
        <div class="field"><label for="call-name">Name</label><input id="call-name" name="name" required minlength="2" maxlength="100" autocomplete="name"></div>
        <div class="field"><label for="call-email">Email</label><input id="call-email" name="email" type="email" required maxlength="254" autocomplete="email"></div>
        <div class="field"><label for="call-phone">Phone</label><input id="call-phone" name="phone" type="tel" required maxlength="30" autocomplete="tel"></div>
        <div class="field field-full"><span>Choose an available day (New York time)</span><div id="call-calendar" class="call-calendar" aria-label="Sales call availability"></div></div>
        <div class="field field-full"><label for="call-time">Available times</label><select id="call-time" name="preferredAt" required disabled><option value="">Select a day first</option></select></div>
        <div class="field field-full"><label for="call-notes">What would you like to discuss? (optional)</label><textarea id="call-notes" name="notes" rows="4" maxlength="2000"></textarea></div>
        <div class="field-full"><button type="submit">Request call</button><div class="form-feedback" role="status"></div></div>
      </form></section></div>`;
    const form = document.querySelector('#call-form');
    const calendar = document.querySelector('#call-calendar');
    const timeSelect = form.elements.preferredAt;
    let availability;
    let selectedDay = '';
    const monthOffset = (month, offset) => {
      const [year, value] = month.split('-').map(Number);
      return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
    };
    async function loadCalendar(month) {
      calendar.setAttribute('aria-busy', 'true');
      selectedDay = '';
      timeSelect.innerHTML = '<option value="">Select a day first</option>';
      timeSelect.disabled = true;
      try {
        availability = await api(`/api/call-availability${month ? `?month=${encodeURIComponent(month)}` : ''}`);
        const [year, value] = availability.month.split('-').map(Number);
        const label = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, value - 1, 1)));
        const firstWeekday = new Date(Date.UTC(year, value - 1, 1)).getUTCDay();
        calendar.innerHTML = `<div class="call-calendar-heading"><button type="button" class="button-secondary" data-month="-1" aria-label="Previous month" ${availability.month <= availability.minMonth ? 'disabled' : ''}>&larr;</button><strong>${esc(label)}</strong><button type="button" class="button-secondary" data-month="1" aria-label="Next month" ${availability.month >= availability.maxMonth ? 'disabled' : ''}>&rarr;</button></div>
          <div class="call-calendar-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => `<span>${day}</span>`).join('')}${'<span></span>'.repeat(firstWeekday)}${availability.days.map(day => `<button type="button" data-day="${day.date}" aria-pressed="false" aria-label="${day.date}${day.slots.length ? ', available' : ', unavailable'}" ${day.slots.length ? '' : 'disabled'}>${Number(day.date.slice(-2))}</button>`).join('')}</div>
          <p class="muted">Unavailable days are disabled. Up to five requests are available per day.</p>`;
      } finally {
        calendar.removeAttribute('aria-busy');
      }
    }
    calendar.addEventListener('click', async event => {
      if (calendar.getAttribute('aria-busy') === 'true') return;
      const button = event.target.closest('button');
      if (!button) return;
      try {
        if (button.dataset.month) {
          await loadCalendar(monthOffset(availability.month, Number(button.dataset.month)));
        } else if (button.dataset.day) {
          selectedDay = button.dataset.day;
          calendar.querySelectorAll('[data-day]').forEach(day => {
            const selected = day.dataset.day === selectedDay;
            day.classList.toggle('selected', selected);
            day.setAttribute('aria-pressed', String(selected));
          });
          const slots = availability.days.find(day => day.date === selectedDay).slots;
          const newYork = new Intl.DateTimeFormat(undefined, { timeZone: availability.timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
          const local = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
          timeSelect.innerHTML = `<option value="">Select a time</option>${slots.map(slot => `<option value="${esc(slot)}">${esc(newYork.format(new Date(slot)))} — ${esc(local.format(new Date(slot)))} local</option>`).join('')}`;
          timeSelect.disabled = false;
        }
      } catch (error) {
        form.querySelector('.form-feedback').textContent = error.message;
        form.querySelector('.form-feedback').className = 'form-feedback error';
      }
    });
    await loadCalendar();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      const feedback = form.querySelector('.form-feedback');
      button.disabled = true;
      try {
        const data = Object.fromEntries(new FormData(form));
        if (!timezone || !selectedDay || !data.preferredAt) throw new Error('Choose an available day and time and ensure your browser time zone is available.');
        data.timezone = timezone;
        const request = await api('/api/call-requests', { method: 'POST', body: JSON.stringify(data) });
        const link = `${location.origin}/book-call?id=${encodeURIComponent(request.id)}#${request.trackingToken}`;
        form.outerHTML = `<div class="success" role="status"><h3>Request received, awaiting confirmation</h3><p>Your preferred time is ${esc(formatDate(request.preferredAt))} (${esc(timezone)}). The team has not confirmed it yet.</p><p>Save this private link to check for confirmation. It is not emailed automatically; anyone with it can view the status.</p><a href="${esc(link)}">${esc(link)}</a></div>`;
      } catch (error) {
        feedback.className = 'form-feedback error';
        feedback.textContent = error.message;
        button.disabled = false;
        try { await loadCalendar(availability.month); } catch (refreshError) {
          feedback.textContent += ` Availability could not be refreshed: ${refreshError.message}`;
        }
      }
    });
  }

  async function adminPage() {
    if (!state.user || state.user.role !== 'admin') {
      app.innerHTML = `<div class="panel empty-state"><h2>Administrator sign-in required</h2><p>Sign in with the admin account configured by the server operator.</p><a class="button" href="/login">Sign in</a></div>`;
      return;
    }
    const summary = await api('/api/admin/summary');
    app.innerHTML = `${pageHeading('TurqueX management', 'Admin dashboard', 'Inventory, order activity and payment analysis.')}
      <div class="stats-grid">${[
        ['Available cars', summary.counts.cars_available],
        ['Cars reserved', summary.counts.cars_reserved],
        ['Cars sold', summary.counts.cars_sold],
        ['Customers', summary.counts.customers],
        ['All orders', summary.counts.orders],
        ['Awaiting payment', summary.counts.pending_orders],
        ['Paid orders', summary.counts.paid_orders],
        ['Confirmed revenue', formatMoney(summary.counts.revenue_usd)]
      ].map(([label, value]) => `<div class="stat-card"><span class="muted">${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>
      <div class="panel" style="margin-top:20px"><h2>Payment method analysis</h2><div class="table-wrap"><table><thead><tr><th>Method</th><th>Status</th><th>Orders</th><th>Order value (USD)</th></tr></thead><tbody>${summary.payments.map(row => `<tr><td>${row.method === 'gourl' ? 'GoUrl crypto' : 'Bank transfer'}</td><td>${esc(row.status.replaceAll('_', ' '))}</td><td>${row.count}</td><td>$${Number(row.total_usd).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>`).join('') || '<tr><td colspan="4">No orders yet.</td></tr>'}</tbody></table></div></div>
      <div class="admin-tabs" role="tablist">
        <button type="button" data-tab="orders" aria-selected="true">Orders</button><button type="button" data-tab="users" aria-selected="false">Users</button><button type="button" data-tab="cars" aria-selected="false">Vehicles</button><button type="button" data-tab="promos" aria-selected="false">Promo codes</button><button type="button" data-tab="bank" aria-selected="false">Bank details</button><button type="button" data-tab="calls" aria-selected="false">Call requests</button><button type="button" data-tab="messages" aria-selected="false">Messages</button><button type="button" data-tab="contact" aria-selected="false">Contact details</button><button type="button" data-tab="emails" aria-selected="false">Email previews</button>
      </div><section id="admin-panel" class="panel"><div class="loading-state">Loading dashboard data...</div></section>`;
    const tabs = document.querySelectorAll('[data-tab]');
    tabs.forEach(button => button.addEventListener('click', () => {
      tabs.forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
      loadAdminTab(button.dataset.tab).catch(showError);
    }));
    await loadAdminTab('orders');
  }

  async function loadAdminTab(tab) {
    const panel = document.querySelector('#admin-panel');
    if (tab === 'users') {
      panel.innerHTML = `<h2>User records</h2><p class="muted">Registered accounts and their order totals. Paid totals include only orders marked paid.</p>
        <form id="user-search" class="button-row"><input name="search" type="search" aria-label="Search users" maxlength="100" placeholder="Search name or email"><button type="submit">Search</button></form>
        <div id="user-results" aria-live="polite"></div>`;
      const form = panel.querySelector('#user-search');
      const results = panel.querySelector('#user-results');
      let requestNumber = 0;
      const load = async page => {
        const request = ++requestNumber;
        const data = await api(`/api/admin/users?search=${encodeURIComponent(form.elements.search.value.trim())}&page=${page}`);
        if (request !== requestNumber || !results.isConnected) return;
        results.innerHTML = `<p class="muted">${data.total} account(s) · Page ${data.page}</p><div class="table-wrap"><table><thead><tr><th>User</th><th>Role / verification</th><th>Registered</th><th>Orders</th><th>Paid total</th></tr></thead><tbody>${data.users.map(user => `<tr>
          <td>${esc(user.name)}<br><a href="mailto:${encodeURIComponent(user.email)}">${esc(user.email)}</a></td><td>${esc(user.role)}<br>${user.email_verified ? 'Email verified' : 'Email unverified'}</td>
          <td>${esc(formatDate(user.created_at))}</td><td>${user.order_count}</td><td>$${Number(user.paid_total).toLocaleString('en-US', { minimumFractionDigits: 2 })} USD</td></tr>`).join('') || '<tr><td colspan="5">No users found.</td></tr>'}</tbody></table></div>
          <div class="button-row"><button type="button" data-user-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button><button type="button" data-user-page="${page + 1}" ${page * data.pageSize >= data.total ? 'disabled' : ''}>Next</button></div>`;
        results.querySelectorAll('[data-user-page]').forEach(button => button.addEventListener('click', () => load(Number(button.dataset.userPage)).catch(showError)));
      };
      form.addEventListener('submit', event => { event.preventDefault(); load(1).catch(showError); });
      await load(1);
      return;
    }
    if (tab === 'emails') {
      const { templates } = await api('/api/admin/email-previews');
      panel.innerHTML = `<h2>Email previews</h2><p class="muted">Sample content only. These are the templates used by the application; no emails are sent from this preview.</p>
        <div class="field"><label for="email-preview-select">Template</label><select id="email-preview-select">${templates.map(template => `<option value="${esc(template.id)}">${esc(template.name)}</option>`).join('')}</select></div>
        <p class="muted">Subject: <strong id="email-preview-subject"></strong></p><iframe class="email-preview-frame" title="Email template preview" sandbox=""></iframe>`;
      const select = panel.querySelector('#email-preview-select');
      let revision = 0;
      const showPreview = async () => {
        const requestRevision = ++revision;
        const result = await api(`/api/admin/email-previews/${encodeURIComponent(select.value)}`);
        if (requestRevision !== revision) return;
        panel.querySelector('#email-preview-subject').textContent = result.subject;
        panel.querySelector('iframe').srcdoc = result.html;
      };
      select.addEventListener('change', () => showPreview().catch(showError));
      await showPreview();
      return;
    }
    if (tab === 'calls') {
      const { requests } = await api('/api/admin/call-requests');
      panel.innerHTML = `<h2>Sales call requests</h2><p class="muted">Confirm only after arranging the call. Updating a status does not send an email; customers can check their private status link.</p>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Preferred time</th><th>Notes</th><th>Status</th><th>Action</th></tr></thead><tbody>${requests.map(request => `<tr>
          <td>${esc(request.name)}<br><a href="mailto:${encodeURIComponent(request.email)}">${esc(request.email)}</a><br>${esc(request.phone)}</td>
          <td>${esc(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: request.timezone }).format(new Date(request.preferred_at)))}<br><span class="muted">${esc(request.timezone)}<br>${esc(request.preferred_at)} UTC</span></td>
          <td class="preserve-lines">${esc(request.notes || '—')}</td><td class="status ${esc(request.status)}">${esc(request.status)}</td>
          <td><button data-call-status="confirmed" data-id="${esc(request.id)}" ${request.status === 'confirmed' ? 'disabled' : ''}>Confirm</button><button class="button-danger" data-call-status="declined" data-id="${esc(request.id)}" ${request.status === 'declined' ? 'disabled' : ''}>Decline</button><button class="button-secondary" data-call-status="requested" data-id="${esc(request.id)}" ${request.status === 'requested' ? 'disabled' : ''}>Reset</button></td>
        </tr>`).join('') || '<tr><td colspan="5">No call requests yet.</td></tr>'}</tbody></table></div>`;
      panel.querySelectorAll('[data-call-status]').forEach(button => button.addEventListener('click', async () => {
        try {
          await api(`/api/admin/call-requests/${encodeURIComponent(button.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.callStatus }) });
          toast('Call request updated. No email was sent.');
          await loadAdminTab('calls');
        } catch (error) { showError(error); }
      }));
      return;
    }
    if (tab === 'messages') {
      const { messages } = await api('/api/admin/contact-messages');
      panel.innerHTML = `<h2>Contact messages</h2><p class="muted">A receipt email is attempted when a message arrives. Reply directly using the customer’s email or phone.</p>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Inquiry</th><th>Message</th><th>Status</th><th>Action</th></tr></thead><tbody>${messages.map(message => `<tr>
          <td>${esc(message.name)}<br><a href="mailto:${encodeURIComponent(message.email)}">${esc(message.email)}</a><br>${esc(message.phone)}</td><td>${esc(message.subject)}<br><span class="muted">${esc(formatDate(message.created_at))}</span></td>
          <td class="preserve-lines">${esc(message.message)}</td><td>${esc(message.status)}<br><span class="${message.confirmation_status === 'failed' ? 'email-failed' : 'muted'}">Receipt email: ${esc(message.confirmation_status || 'not tracked')}</span></td><td><button data-message-status="${message.status === 'new' ? 'handled' : 'new'}" data-id="${esc(message.id)}">${message.status === 'new' ? 'Mark handled' : 'Mark new'}</button></td>
        </tr>`).join('') || '<tr><td colspan="5">No messages yet.</td></tr>'}</tbody></table></div>`;
      panel.querySelectorAll('[data-message-status]').forEach(button => button.addEventListener('click', async () => {
        try {
          await api(`/api/admin/contact-messages/${encodeURIComponent(button.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.messageStatus }) });
          await loadAdminTab('messages');
        } catch (error) { showError(error); }
      }));
      return;
    }
    if (tab === 'contact') {
      const { contact } = await api('/api/admin/settings');
      panel.innerHTML = `<h2>Public contact details</h2><p class="muted">These details appear on the contact page and footer. Leave fields blank if they are not ready to publish. The phone shortcut opens the call-request form until a number is set.</p>
        <form id="contact-settings-form" class="form-grid">
          <div class="field"><label for="settings-phone">Phone (international format, e.g. +12025550123)</label><input id="settings-phone" name="phone" type="tel" value="${esc(contact.phone || '')}" maxlength="16"></div>
          <div class="field"><label for="settings-hours">Hours</label><input id="settings-hours" name="hours" value="${esc(contact.hours || '')}" maxlength="300"></div>
          <div class="field field-full"><label for="settings-address">Address</label><textarea id="settings-address" name="address" rows="2" maxlength="300">${esc(contact.address || '')}</textarea></div>
          <div class="field-full"><button type="submit">Save contact details</button></div>
        </form>`;
      panel.querySelector('#contact-settings-form').addEventListener('submit', async event => {
        event.preventDefault();
        try {
          const result = await api('/api/admin/settings/contact', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
          state.contact = result.contact;
          renderContactShortcuts();
          toast('Contact details saved.');
        } catch (error) { showError(error); }
      });
      return;
    }
    if (tab === 'orders') {
      const [{ orders }, { banks }] = await Promise.all([api('/api/admin/orders'), api('/api/admin/banks')]);
      panel.innerHTML = `<h2>Customer orders</h2><p class="muted">Unassigned bank orders hold vehicles until assigned or cancelled. Assigning a bank locks the conversion and starts the one-hour payment window. Shipment stages are updated manually after payment is confirmed; each update attempts a customer email.</p><div class="table-wrap"><table><thead><tr><th>Order / customer</th><th>Vehicles</th><th>Payment</th><th>Total</th><th>Status</th><th>Action</th></tr></thead><tbody>${orders.map(order => `<tr>
        <td>${esc(order.id)}<br><span class="muted">${esc(order.customerName)} · ${esc(order.customerEmail)}</span></td>
        <td>${order.items.map(item => `${esc(item.year)} ${esc(item.make)} ${esc(item.model)} × ${item.quantity}`).join('<br>')}</td>
        <td>${order.paymentMethod === 'gourl' ? 'GoUrl crypto' : `Bank transfer<br><span class="muted">Requested currency: ${esc(order.currency)}</span><br><span class="${order.notificationStatus === 'failed' ? 'email-failed' : 'muted'}">${order.notificationStatus === 'failed' ? 'Order email failed — check SMTP.' : `Order email: ${esc(order.notificationStatus || 'not tracked')}`}</span>`}${order.expiresAt ? `<br><span class="muted">Payment deadline: ${esc(formatDate(order.expiresAt))}</span>` : ''}
          ${order.paymentDetails?.amount != null ? `<br><span class="muted">Assigned: ${esc(order.paymentDetails.amount)} ${esc(order.paymentDetails.currency)} · ${esc(order.paymentDetails.bankDetails?.bankName)}</span>` : ''}
          ${order.status === 'awaiting_bank_assignment' ? `<form class="assign-bank-form" data-id="${esc(order.id)}"><label>Assign bank <select name="bankId" required><option value="">Choose account</option>${banks.filter(bank => bank.currency).map(bank => `<option value="${esc(bank.id)}">${esc(bank.bankName)} · ${esc(bank.currency)} · ${esc(bank.accountName)}</option>`).join('')}</select></label><button type="submit">Assign bank</button></form>${banks.some(bank => bank.currency) ? '' : '<span class="muted">Add a bank with a currency first.</span>'}` : ''}
          ${order.proofUploadedAt ? `<br><a href="/api/admin/orders/${encodeURIComponent(order.id)}/payment-proof">Download payment proof</a>` : ''}
        </td>
        <td>$${Number(order.totalUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
        <td><span class="status ${esc(order.status)}">${esc(order.status.replaceAll('_', ' '))}</span><br><span class="muted">Shipment: ${esc(shipmentLabels[order.tracking?.shipmentStatus] || 'Not updated')}</span><br><span class="${order.tracking?.emailStatus === 'failed' ? 'email-failed' : 'muted'}">${order.tracking?.emailStatus === 'failed' ? 'Tracking email failed — check SMTP and PUBLIC_BASE_URL.' : `Tracking email: ${esc(order.tracking?.emailStatus || 'not sent')}`}</span></td>
        <td>${['awaiting_bank_assignment', 'awaiting_payment', 'payment_received', 'payment_claimed', 'proof_submitted'].includes(order.status) ? `${order.status === 'awaiting_bank_assignment' ? '' : `<button data-order-action="paid" data-id="${esc(order.id)}">Mark paid</button>`}<button class="button-danger" data-order-action="cancelled" data-id="${esc(order.id)}">Cancel</button>` : ''}
          ${order.status === 'paid' ? `<form class="shipment-form" data-id="${esc(order.id)}"><label>Shipment stage<select name="status" required><option value="">Choose stage</option>${Object.entries(shipmentLabels).map(([key, label]) => `<option value="${esc(key)}" ${order.tracking?.shipmentStatus === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label><button type="submit">Update shipment</button></form>` : ''}
          ${order.tracking ? `<button type="button" class="button-secondary" data-tracking-email="${esc(order.id)}">Send tracking email</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="6">No orders yet.</td></tr>'}</tbody></table></div>`;
      panel.querySelectorAll('.shipment-form').forEach(form => form.addEventListener('submit', async event => {
        event.preventDefault();
        const status = form.elements.status.value;
        if (!status || !confirm(`Update shipment to ${shipmentLabels[status]}? The customer will be emailed if delivery is configured.`)) return;
        const button = form.querySelector('button');
        button.disabled = true;
        try {
          const result = await api(`/api/admin/orders/${encodeURIComponent(form.dataset.id)}/shipment`, { method: 'PATCH', body: JSON.stringify({ status }) });
          await loadAdminTab('orders');
          toast(result.emailStatus === 'sent' ? 'Shipment updated; email accepted by the mail server.' : 'Shipment updated, but the tracking email failed.');
        } catch (error) {
          button.disabled = false;
          showError(error);
        }
      }));
      panel.querySelectorAll('[data-tracking-email]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/api/admin/orders/${encodeURIComponent(button.dataset.trackingEmail)}/tracking-email`, { method: 'POST', body: '{}' });
          await loadAdminTab('orders');
          toast('Tracking email accepted by the mail server.');
        } catch (error) {
          await loadAdminTab('orders').catch(showError);
          showError(error);
        }
      }));
      panel.querySelectorAll('.assign-bank-form').forEach(form => form.addEventListener('submit', async event => {
        event.preventDefault();
        const bank = banks.find(item => item.id === form.elements.bankId.value);
        if (!bank || !confirm(`Assign ${bank.bankName} (${bank.currency})? This locks the conversion and starts the one-hour payment window. Assigned details cannot be changed.`)) return;
        const button = form.querySelector('button');
        button.disabled = true;
        try {
          const result = await api(`/api/admin/orders/${encodeURIComponent(form.dataset.id)}/assign-bank`, { method: 'POST', body: JSON.stringify({ bankId: bank.id }) });
          toast(`Bank assigned: ${result.paymentDetails.amount} ${result.paymentDetails.currency}.`);
          await loadAdminTab('orders');
        } catch (error) {
          button.disabled = false;
          showError(error);
        }
      }));
      panel.querySelectorAll('[data-order-action]').forEach(button => button.addEventListener('click', async () => {
        if (!confirm(`${button.dataset.orderAction === 'paid' ? 'Mark this order as paid?' : 'Cancel this order and release its vehicles?'}`)) return;
        try {
          await api(`/api/admin/orders/${encodeURIComponent(button.dataset.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.orderAction }) });
          toast('Order updated.');
          await adminPage();
        } catch (error) { showError(error); }
      }));
      return;
    }
    if (tab === 'cars') {
      const { cars } = await api('/api/admin/cars');
      panel.innerHTML = `<h2>Manage vehicles</h2><p class="muted">Available stock excludes vehicles currently reserved or sold. Updating it does not change existing orders.</p><form id="car-form" class="form-grid">
        <input type="hidden" name="id">
        <div class="field"><label>Make</label><input name="make" required maxlength="80"></div><div class="field"><label>Model</label><input name="model" required maxlength="100"></div>
        <div class="field"><label>Year</label><input name="year" type="number" min="1900" max="${new Date().getFullYear() + 2}" required></div><div class="field"><label>Price (USD)</label><input name="priceUsd" type="number" min="1" step=".01" required></div>
        <div class="field"><label>Mileage</label><input name="mileage" type="number" min="0" required value="0"></div><div class="field"><label>Transmission</label><select name="transmission"><option>Automatic</option><option>Manual</option><option>CVT</option><option>Other</option></select></div>
        <div class="field"><label>Available stock</label><input name="availableStock" type="number" min="0" max="100000" required value="1"></div>
        <div class="field"><label>Body type</label><select name="bodyType"><option>Sedan</option><option>SUV</option><option>Coupe</option><option>Convertible</option><option>Hatchback</option><option>Wagon</option><option>Truck</option><option>Other</option></select></div><div class="field"><label>Image URL</label><input name="imageUrl" placeholder="/assets/img/deal/2.jpg or https://..." maxlength="1000"></div>
        <div class="field field-full"><label>Description</label><textarea name="description" rows="3" maxlength="4000"></textarea></div>
        <div class="button-row field-full"><button type="submit">Save vehicle</button><button id="cancel-car-edit" type="button" class="button-secondary">Clear form</button></div>
      </form><div class="table-wrap" style="margin-top:25px"><table><thead><tr><th>Vehicle</th><th>Price</th><th>Available stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>${cars.map(car => `<tr><td>${esc(car.year)} ${esc(car.make)} ${esc(car.model)}</td><td>$${Number(car.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>${car.availableStock}</td><td>${esc(car.status.replaceAll('_', ' '))}</td><td><button data-edit-car="${esc(car.id)}">Edit</button><button class="button-danger" data-delete-car="${esc(car.id)}" ${!['available', 'out_of_stock'].includes(car.status) ? 'disabled' : ''}>Delete</button></td></tr>`).join('')}</tbody></table></div>`;
      const form = panel.querySelector('#car-form');
      const clearForm = () => { form.reset(); form.elements.id.value = ''; };
      panel.querySelector('#cancel-car-edit').addEventListener('click', clearForm);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        const id = data.id;
        delete data.id;
        data.year = Number(data.year);
        data.priceUsd = Number(data.priceUsd);
        data.mileage = Number(data.mileage);
        data.availableStock = Number(data.availableStock);
        if (id) data.expectedAvailableStock = cars.find(car => car.id === id).availableStock;
        try {
          await api(id ? `/api/admin/cars/${encodeURIComponent(id)}` : '/api/admin/cars', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify(data)
          });
          toast('Vehicle saved.');
          await loadAdminTab('cars');
        } catch (error) { showError(error); }
      });
      panel.querySelectorAll('[data-edit-car]').forEach(button => button.addEventListener('click', () => {
        const car = cars.find(item => item.id === button.dataset.editCar);
        for (const [key, value] of Object.entries({
          id: car.id, make: car.make, model: car.model, year: car.year, priceUsd: car.priceUsd,
          mileage: car.mileage, transmission: car.transmission, bodyType: car.bodyType,
          imageUrl: car.imageUrl, description: car.description, availableStock: car.availableStock
        })) form.elements[key].value = value ?? '';
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }));
      panel.querySelectorAll('[data-delete-car]').forEach(button => button.addEventListener('click', async () => {
        if (!confirm('Delete this vehicle?')) return;
        try {
          await api(`/api/admin/cars/${encodeURIComponent(button.dataset.deleteCar)}`, { method: 'DELETE' });
          toast('Vehicle deleted.');
          await loadAdminTab('cars');
        } catch (error) { showError(error); }
      }));
      return;
    }
    if (tab === 'promos') {
      const [{ promos }, { cars }] = await Promise.all([api('/api/admin/promos'), api('/api/admin/cars')]);
      const brands = [...new Map(cars.map(car => [car.make.trim().toLocaleLowerCase('en-US'), car.make.trim()])).values()].sort((a, b) => a.localeCompare(b));
      panel.innerHTML = `<h2>Voucher and promo codes</h2><form id="promo-form" class="form-grid">
        <div class="field"><label>Code</label><input name="code" required minlength="3" maxlength="30" pattern="(?:[A-Za-z0-9_]|-)+"></div>
        <div class="field"><label>Discount type</label><select name="kind"><option value="percent">Percent</option><option value="fixed">Fixed USD amount</option></select></div>
        <div class="field"><label>Discount amount</label><input name="amount" type="number" min=".01" step=".01" required></div>
        <div class="field field-full"><label>Description</label><textarea name="description" rows="2" maxlength="500" required></textarea></div>
        <div class="field"><label>Maximum uses (optional)</label><input name="usesLimit" type="number" min="1"></div>
        <div class="field"><label>Expires (optional)</label><input name="expiresAt" type="datetime-local"></div>
        <div class="field field-full"><label for="promo-brand-scope">Eligible brands</label><select id="promo-brand-scope" name="brandScope"><option value="all">All brands</option><option value="selected">Selected brands</option></select></div>
        <div class="field field-full" id="promo-brands-field" hidden><label for="promo-brands">Select one or more brands</label><select id="promo-brands" name="brands" multiple size="5">${brands.map(brand => `<option value="${esc(brand)}">${esc(brand)}</option>`).join('')}</select><small class="muted">Use Ctrl or Command to select multiple brands.</small></div>
        <div class="button-row" style="align-items:end"><button type="submit">Create promo</button></div>
      </form><div class="table-wrap" style="margin-top:24px"><table><thead><tr><th>Code / description</th><th>Discount</th><th>Brands</th><th>Uses</th><th>Expiry</th><th>State</th><th>Action</th></tr></thead><tbody>${promos.map(promo => `<tr><td>${esc(promo.code)}<br><span class="muted">${esc(promo.description || 'No description')}</span></td><td>${promo.kind === 'percent' ? `${promo.amount}%` : `$${Number(promo.amount).toFixed(2)}`}</td><td>${esc(promo.brands.length ? promo.brands.join(', ') : 'All brands')}</td><td>${promo.usesCount}${promo.usesLimit ? ` / ${promo.usesLimit}` : ''}</td><td>${promo.expiresAt ? formatDate(promo.expiresAt) : 'No expiry'}</td><td>${promo.active ? 'Active' : 'Inactive'}${promo.pinned ? ' · Pinned' : ''}</td><td><button data-pin-promo="${esc(promo.id)}" data-pinned="${promo.pinned ? 'false' : 'true'}">${promo.pinned ? 'Unpin' : 'Pin promotion'}</button><button data-toggle-promo="${esc(promo.id)}" data-active="${promo.active ? 'false' : 'true'}">${promo.active ? 'Disable' : 'Enable'}</button><button class="button-danger" data-delete-promo="${esc(promo.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7">No promo codes created yet.</td></tr>'}</tbody></table></div>`;
      panel.querySelector('#promo-brand-scope').addEventListener('change', event => {
        const selected = event.currentTarget.value === 'selected';
        panel.querySelector('#promo-brands-field').hidden = !selected;
        panel.querySelector('#promo-brands').required = selected;
      });
      panel.querySelector('#promo-form').addEventListener('submit', async event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget));
        data.brands = data.brandScope === 'selected' ? [...event.currentTarget.elements.brands.selectedOptions].map(option => option.value) : [];
        delete data.brandScope;
        data.amount = Number(data.amount);
        data.usesLimit = data.usesLimit ? Number(data.usesLimit) : null;
        if (data.expiresAt) data.expiresAt = new Date(data.expiresAt).toISOString();
        try {
          await api('/api/admin/promos', { method: 'POST', body: JSON.stringify(data) });
          toast('Promo code created.');
          await loadAdminTab('promos');
        } catch (error) { showError(error); }
      });
      panel.querySelectorAll('[data-toggle-promo]').forEach(button => button.addEventListener('click', async () => {
        try {
          await api(`/api/admin/promos/${encodeURIComponent(button.dataset.togglePromo)}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active === 'true' }) });
          await renderPromotion();
          await loadAdminTab('promos');
        } catch (error) { showError(error); }
      }));
      panel.querySelectorAll('[data-pin-promo]').forEach(button => button.addEventListener('click', async () => {
        try {
          await api(`/api/admin/promos/${encodeURIComponent(button.dataset.pinPromo)}`, { method: 'PATCH', body: JSON.stringify({ pinned: button.dataset.pinned === 'true' }) });
          await renderPromotion();
          toast(button.dataset.pinned === 'true' ? 'Promotion pinned.' : 'Promotion unpinned.');
          await loadAdminTab('promos');
        } catch (error) { showError(error); }
      }));
      panel.querySelectorAll('[data-delete-promo]').forEach(button => button.addEventListener('click', async () => {
        if (!confirm('Delete this promo code?')) return;
        try {
          await api(`/api/admin/promos/${encodeURIComponent(button.dataset.deletePromo)}`, { method: 'DELETE' });
          await renderPromotion();
          await loadAdminTab('promos');
        } catch (error) { showError(error); }
      }));
      return;
    }
    if (tab === 'bank') {
      const { banks } = await api('/api/admin/banks');
      panel.innerHTML = `<h2>Bank accounts</h2><p class="muted">Add accounts in their actual currency. Assign one to each bank order from the Orders tab. Changes do not alter details already assigned to an order. Previously saved accounts need a currency before assignment.</p>
        <form id="bank-form" class="form-grid">
          <input type="hidden" name="id">
          <div class="field"><label>Account name<input name="accountName" required maxlength="500"></label></div>
          <div class="field"><label>Bank name<input name="bankName" required maxlength="500"></label></div>
          <div class="field"><label>Account number / IBAN<input name="accountNumber" required maxlength="500"></label></div>
          <div class="field"><label>Currency code (e.g. USD, EUR, GBP)<input name="currency" required pattern="[A-Za-z]{3}" maxlength="3"></label></div>
          <div class="field"><label>Routing / sort code<input name="routingNumber" maxlength="500"></label></div>
          <div class="field"><label>SWIFT / BIC<input name="swiftCode" maxlength="500"></label></div>
          <div class="field field-full"><label>Payment instructions<textarea name="instructions" rows="3" maxlength="500"></textarea></label></div>
          <div class="button-row field-full"><button type="submit">Save bank account</button><button type="button" class="button-secondary" id="clear-bank">Clear form</button></div>
        </form><div class="table-wrap" style="margin-top:24px"><table><thead><tr><th>Bank</th><th>Account</th><th>Currency</th><th>Actions</th></tr></thead><tbody>${banks.map(bank => `<tr><td>${esc(bank.bankName)}</td><td>${esc(bank.accountName)}<br>${esc(bank.accountNumber)}</td><td>${esc(bank.currency || 'Set currency')}</td><td><button data-edit-bank="${esc(bank.id)}">Edit</button><button class="button-danger" data-delete-bank="${esc(bank.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4">No bank accounts added.</td></tr>'}</tbody></table></div>`;
      const form = panel.querySelector('#bank-form');
      panel.querySelector('#clear-bank').addEventListener('click', () => { form.reset(); form.elements.id.value = ''; });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        const id = data.id;
        delete data.id;
        try {
          await api(id ? `/api/admin/banks/${encodeURIComponent(id)}` : '/api/admin/banks', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) });
          toast('Bank account saved.');
          await loadAdminTab('bank');
        } catch (error) { showError(error); }
      });
      panel.querySelectorAll('[data-edit-bank]').forEach(button => button.addEventListener('click', () => {
        const bank = banks.find(item => item.id === button.dataset.editBank);
        for (const [key, value] of Object.entries(bank)) form.elements[key].value = value ?? '';
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }));
      panel.querySelectorAll('[data-delete-bank]').forEach(button => button.addEventListener('click', async () => {
        if (!confirm('Delete this bank account? Already-assigned orders keep their existing payment details.')) return;
        try {
          await api(`/api/admin/banks/${encodeURIComponent(button.dataset.deleteBank)}`, { method: 'DELETE' });
          await loadAdminTab('bank');
        } catch (error) { showError(error); }
      }));
    }
  }

  function showError(error) {
    toast(error.message || 'An unexpected error occurred.');
  }

  async function renderPage() {
    const path = location.pathname;
    try {
      clearInterval(state.timer);
      state.timer = null;
      if (heroSwiper) {
        heroSwiper.destroy(true, true);
        heroSwiper = null;
      }
      if (path === '/' || path === '/index.html') return await homePage();
      if (path === '/about') return aboutPage();
      if (path === '/cars' || path === '/shop.html' || path === '/deal.html') return await carsPage();
      if (path.startsWith('/cars/')) return await carPage(decodeURIComponent(path.slice('/cars/'.length)));
      if (path === '/cart' || path === '/cart.html') return await cartPage();
      if (path === '/checkout' || path === '/checkout.html') return await checkoutPage();
      if (path === '/login' || path === '/login.html') return await loginPage(false);
      if (path === '/register' || path === '/register.html') return await loginPage(true);
      if (path === '/verify-email') return await verifyEmailPage();
      if (path === '/account') return await accountPage();
      if (path === '/settings') return settingsPage();
      if (path === '/reset-password') return resetPasswordPage();
      if (path === '/track') return await trackingPage();
      if (path === '/admin') return await adminPage();
      if (path === '/contact' || path === '/contact.html') return contactPage();
      if (path === '/book-call') return await bookCallPage();
      app.innerHTML = `<div class="panel empty-state"><h1>Page not found</h1><a class="button" href="/">Return home</a></div>`;
    } catch (error) {
      app.innerHTML = `<div class="panel empty-state"><h1>We could not load this page</h1><p>${esc(error.message)}</p><button id="retry" type="button">Try again</button></div>`;
      document.querySelector('#retry').addEventListener('click', async () => {
        if (await renderPage() !== false) await setupTranslation();
      });
      return false;
    }
  }

  function renderContactShortcuts() {
    const phone = state.contact?.phone;
    const shortcut = document.querySelector('#phone-shortcut');
    shortcut.href = phone ? `tel:${phone}` : '/book-call';
    shortcut.setAttribute('aria-label', phone ? `Call ${phone}` : 'Request a sales call');
    shortcut.title = phone ? `Call ${phone}` : 'Request a sales call';
    const phoneElement = document.querySelector('#footer-phone');
    phoneElement.innerHTML = phone ? `<i class="ri-phone-line" aria-hidden="true"></i> <a href="tel:${esc(phone)}">${esc(phone)}</a>` :
      (state.contact ? '<a href="/book-call">Request a call</a>.' : 'Contact details are temporarily unavailable.');
    document.querySelector('#footer-address').textContent = state.contact?.address || '';
    document.querySelector('#footer-hours').textContent = state.contact?.hours || '';
  }

  async function renderPromotion() {
    const banner = document.querySelector('#promo-banner');
    let promo;
    try { ({ promo } = await api('/api/promos/featured')); }
    catch (error) {
      banner.hidden = true;
      throw error;
    }
    banner.hidden = !promo;
    banner.innerHTML = promo ? `<strong>${promo.kind === 'percent' ? `${esc(promo.amount)}% off` : `${esc(formatMoney(promo.amount))} off`}</strong> with code <strong class="notranslate" translate="no">${esc(promo.code)}</strong>${promo.brands?.length ? ` · Eligible brands: ${escWithBrand(promo.brands.join(', '))}` : ''}${promo.description ? ` · ${escWithBrand(promo.description)}` : ''}<a href="/cars">Shop vehicles</a>` : '';
  }

  function protectTranslationInputs() {
    const selector = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
    const protect = element => {
      element.classList.add('notranslate');
      element.setAttribute('translate', 'no');
    };
    const protectWithin = root => {
      if (root instanceof Element && root.matches(selector)) protect(root);
      root.querySelectorAll(selector).forEach(protect);
    };
    protectWithin(document);
    const observer = new MutationObserver(records => records.forEach(record => {
      if (record.type === 'attributes') protectWithin(record.target);
      record.addedNodes.forEach(node => {
        if (node instanceof Element) protectWithin(node);
      });
    }));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable'] });
  }

  async function setupTranslation() {
    if (translationInitialized) return;
    const picker = document.querySelector('#translation-picker');
    const status = document.querySelector('#translation-status');
    picker.hidden = false;
    try {
      const { gtranslateEnabled } = await api('/api/site-config');
      if (!gtranslateEnabled) {
        status.textContent = 'Coming soon';
        return;
      }
      protectTranslationInputs();
      window.gtranslateSettings = {
        default_language: 'en',
        languages: ['en', 'es', 'fr', 'de', 'pt', 'ar', 'zh-CN', 'ja', 'it', 'ko', 'hi', 'nl', 'tr', 'ru', 'pl', 'uk', 'sv', 'id', 'vi', 'th', 'sw'],
        wrapper_selector: '.gtranslate_wrapper',
        native_language_names: true,
        url_structure: 'none'
      };
      const script = document.createElement('script');
      script.src = 'https://cdn.gtranslate.net/widgets/latest/dropdown.js';
      script.onload = () => {
        if (!picker.querySelector('.gt_selector')) {
          status.textContent = 'Unavailable';
          console.error('GTranslate did not initialize its language selector.');
        }
      };
      script.onerror = () => {
        status.textContent = 'Unavailable';
        console.error('Could not load the GTranslate language selector.');
      };
      translationInitialized = true;
      document.body.appendChild(script);
    } catch (error) {
      status.textContent = 'Unavailable';
      console.error('Could not load translation configuration:', error);
    }
  }

  async function initialize() {
    state.currency = localStorage.getItem(currencyKey) || 'USD';
    const currencySelect = document.querySelector('#currency-select');
    if ([...currencySelect.options].some(option => option.value === state.currency)) currencySelect.value = state.currency;
    currencySelect.addEventListener('change', () => {
      state.currency = currencySelect.value;
      localStorage.setItem(currencyKey, state.currency);
      renderPage().catch(showError);
    });
    document.querySelector('.nav-toggle').addEventListener('click', event => {
      const open = document.querySelector('.site-nav').classList.toggle('open');
      event.currentTarget.setAttribute('aria-expanded', String(open));
    });
    const dropdowns = document.querySelectorAll('.nav-dropdown');
    dropdowns.forEach(dropdown => dropdown.addEventListener('toggle', () => {
      if (dropdown.open) dropdowns.forEach(other => { if (other !== dropdown) other.open = false; });
    }));
    document.addEventListener('click', event => {
      dropdowns.forEach(dropdown => { if (!dropdown.contains(event.target)) dropdown.open = false; });
    });
    document.querySelector('#logout-button').addEventListener('click', async () => {
      try {
        await api('/api/auth/logout', { method: 'POST', body: '{}' });
        state.user = null;
        location.href = '/';
      } catch (error) { showError(error); }
    });
    updateCartCount();
    try {
      const csrf = await api('/api/csrf');
      state.token = csrf.token;
      const [me, rates] = await Promise.allSettled([api('/api/me'), api('/api/rates')]);
      const user = me.status === 'fulfilled' ? me.value.user : undefined;
      if (user === null || (user && typeof user.id === 'string' && typeof user.name === 'string' && typeof user.role === 'string')) {
        state.user = user;
      }
      else console.error('Could not load account:', me.status === 'rejected' ? me.reason : 'Invalid account response.');
      if (rates.status === 'fulfilled') state.rates = rates.value;
      else console.error('Could not load exchange rates:', rates.reason);
    } catch (error) {
      console.error('Storefront initialization failed:', error);
    }
    try {
      const { contact } = await api('/api/contact-details');
      state.contact = contact;
    } catch (error) {
      console.error('Could not load contact details:', error);
    }
    renderContactShortcuts();
    renderAuth();
    try { await renderPromotion(); }
    catch (error) { console.error('Could not load the featured promotion:', error); }
    setInterval(() => renderPromotion().catch(error => console.error('Could not refresh the featured promotion:', error)), 60000);
    AOS.init({
      duration: 1000,
      once: true,
      easing: 'ease-in-out',
      offset: 100,
      disable: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    });
    await renderPage();
    await setupTranslation();
  }

  initialize().catch(error => {
    app.innerHTML = `<div class="panel empty-state"><h1><span class="notranslate" translate="no">TurqueX</span> is temporarily unavailable</h1><p>${esc(error.message)}</p></div>`;
  }).finally(() => {
    initializing = false;
    clearTimeout(initializationTimeout);
    loadingScreen.classList.add('is-hidden');
    loadingScreen.setAttribute('aria-hidden', 'true');
  });
})();
