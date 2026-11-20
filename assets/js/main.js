//  LOADING SCREEN  
window.addEventListener('load', () => {
  setTimeout(() => {
    document.getElementById('loading-screen').style.opacity = '0';
    document.getElementById('loading-screen').style.visibility = 'hidden';
  }, 1500);
});

//  CUSTOM CURSOR  
const cursor = document.querySelector('.custom-cursor');
const cursorDot = document.querySelector('.cursor-dot');

document.addEventListener('mousemove', (e) => {
  cursor.style.left = e.clientX + 'px';
  cursor.style.top = e.clientY + 'px';
  cursorDot.style.left = e.clientX + 'px';
  cursorDot.style.top = e.clientY + 'px';
});

document.addEventListener('mousedown', () => {
  cursor.style.transform = 'translate(-50%, -50%) scale(0.8)';
  cursorDot.style.transform = 'translate(-50%, -50%) scale(0.8)';
});

document.addEventListener('mouseup', () => {
  cursor.style.transform = 'translate(-50%, -50%) scale(1)';
  cursorDot.style.transform = 'translate(-50%, -50%) scale(1)';
});

// Add hover effect to interactive elements
const interactiveElements = document.querySelectorAll('a, button, .btn, input, select, textarea, .project-item, .instagram-item');
interactiveElements.forEach(el => {
  el.addEventListener('mouseenter', () => cursor.classList.add('hover'));
  el.addEventListener('mouseleave', () => cursor.classList.remove('hover'));
});

//  SCROLL PROGRESS  
window.addEventListener('scroll', () => {
  const scrollProgress = document.querySelector('.scroll-progress');
  const scrollTop = window.scrollY;
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const scrollPercent = (scrollTop / docHeight) * 100;
  scrollProgress.style.width = scrollPercent + '%';
});

//  BACK TO TOP  
const backToTop = document.getElementById('backToTop');
window.addEventListener('scroll', () => {
  if (window.scrollY > 500) {
    backToTop.classList.add('active');
  } else {
    backToTop.classList.remove('active');
  }
});
backToTop.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/**  Nav-menu JS  **/
document.addEventListener("DOMContentLoaded", () => {
  const menuBtn = document.querySelector(".menu-btn");
  const menuOverlay = document.querySelector(".menu-overlay");
  const menuItems = document.querySelector(".mobile-menu");
  const closeMenu = document.querySelector(".close-menu");

  if (menuBtn && menuOverlay && menuItems && closeMenu) {
    menuBtn.addEventListener("click", () => {
      menuOverlay.classList.add("show");
      menuItems.classList.add("open");
      document.body.classList.add("no-scroll");
    });

    [closeMenu, menuOverlay].forEach((el) => {
      if (!el) return; // prevent crash

      el.addEventListener("click", () => {
        menuOverlay.classList.remove("show");
        menuItems.classList.remove("open");
        document.body.classList.remove("no-scroll");
      });
    });
  }
});
document.addEventListener("click", function (e) {
  const trigger = e.target.closest(".mobile-expand-drop");

  if (!trigger) return;

  e.preventDefault();
  e.stopPropagation();

  const parent = trigger.closest(".mobile-dropdown");
  const submenu = parent.querySelector(".mobile-dropdown-menu");

  if (!submenu) return;

  const isOpen = parent.classList.contains("active");

  // Close all
  document.querySelectorAll(".mobile-dropdown").forEach(item => {
    item.classList.remove("active");
    const menu = item.querySelector(".mobile-dropdown-menu");
    if (menu) menu.style.maxHeight = null;
  });

  // Open current if it was closed
  if (!isOpen) {
    parent.classList.add("active");
    submenu.style.maxHeight = submenu.scrollHeight + "px";
  }
});

// Hero Images 2
const boxes = document.querySelectorAll('.tr-hero-film');

if (boxes.length > 0) {

  let currentIndex = 0;
  let interval;

  function setActive(index) {
    boxes.forEach(box => box.classList.remove('active'));
    boxes[index].classList.add('active');
    currentIndex = index;
  }

  function autoChange() {
    currentIndex = (currentIndex + 1) % boxes.length;
    setActive(currentIndex);
  }

  // Init first active
  setActive(0);

  // Start auto rotation
  function startInterval() {
    clearInterval(interval);
    interval = setInterval(autoChange, 5000);
  }

  function stopInterval() {
    clearInterval(interval);
  }

  startInterval();

  // Hover functionality
  boxes.forEach((box, index) => {

    box.addEventListener('mouseenter', () => {
      stopInterval();
      setActive(index);
    });

    box.addEventListener('mouseleave', () => {
      startInterval();
    });

  });
}

//  HERO SWIPER  
const heroSwiper = new Swiper('.hero-swiper', {
  loop: true,
  autoplay: {
    delay: 5000,
    disableOnInteraction: false,
  },
  speed: 1000,
  effect: 'fade',
  fadeEffect: {
    crossFade: true
  },
  parallax: true,
  pagination: {
    el: '.swiper-pagination',
    clickable: true,
  },
  navigation: {
    nextEl: '.swiper-button-next',
    prevEl: '.swiper-button-prev',
  },
});

//  TESTIMONIAL SWIPER  
const testimonialSwiper = new Swiper('.testimonial-swiper', {
  slidesPerView: 1,
  spaceBetween: 24,
  loop: true,
  autoplay: {
    delay: 4000,
  },
  pagination: {
    el: '.swiper-pagination',
    clickable: true,
  },
  breakpoints: {
    768: {
      slidesPerView: 1,
    },
    992: {
      slidesPerView: 2,
    },
    1400: {
      slidesPerView: 3,
    },
  },
});
//  PARTS SWIPER  
const partsSwiper = new Swiper('.parts-slider', {
  slidesPerView: 1,
  spaceBetween: 24,
  loop: true,
  pagination: {
    el: '.swiper-pagination',
    clickable: true,
  },
  breakpoints: {
    575: {
      slidesPerView: 2,
    },
    768: {
      slidesPerView: 2,
    },
    992: {
      slidesPerView: 3,
    },
    1200: {
      slidesPerView: 4,
    },
  },
});
//  TEAM SWIPER  
const teamSwiper = new Swiper('.team-swiper', {
  slidesPerView: 1,
  spaceBetween: 24,
  loop: true,
  pagination: {
    el: '.swiper-pagination',
    clickable: true,
  },
  breakpoints: {
    576: {
      slidesPerView: 1,
    },
    768: {
      slidesPerView: 2,
    },
    992: {
      slidesPerView: 2,
    },
    1400: {
      slidesPerView: 3,
    },
  },
});
//  BLOG SWIPER  
const blogSwiper = new Swiper('.blog-swiper', {
  slidesPerView: 1,
  spaceBetween: 24,
  loop: true,
  pagination: {
    el: '.swiper-pagination',
    clickable: true,
  },
  breakpoints: {
    576: {
      slidesPerView: 1,
    },
    768: {
      slidesPerView: 2,
    },
    992: {
      slidesPerView: 2,
    },
    1400: {
      slidesPerView: 3,
    },
  },
});
//  INSTA ANIMATION  
$(function () {
  // Check if the element exists
  if ($('.insta-auto').length > 0) {
    $('.insta-auto').infiniteslide({
      direction: 'left',
      speed: 50,
      clone: 10
    });
  }
});
//  AOS ANIMATION  
AOS.init({
  duration: 1000,
  once: true,
  easing: 'ease-in-out',
  offset: 100,
});

//  PARTICLES.JS  
document.addEventListener("DOMContentLoaded", function () {

  const particlesElement = document.getElementById("particles-js");

  if (particlesElement) {

    particlesJS('particles-js', {
      particles: {
        number: {
          value: 50,
          density: {
            enable: true,
            value_area: 800
          }
        },
        color: {
          value: '#ff4c29'
        },
        shape: {
          type: 'circle',
        },
        opacity: {
          value: 0.15,
          random: true,
          anim: {
            enable: true,
            speed: 1,
            opacity_min: 0.05,
            sync: false
          }
        },
        size: {
          value: 3,
          random: true,
          anim: {
            enable: true,
            speed: 2,
            size_min: 1,
            sync: false
          }
        },
        line_linked: {
          enable: true,
          distance: 150,
          color: '#ff4c29',
          opacity: 0.1,
          width: 1
        },
        move: {
          enable: true,
          speed: 1.5,
          direction: 'none',
          random: true,
          straight: false,
          out_mode: 'out',
          bounce: false,
        }
      },
      interactivity: {
        detect_on: 'canvas',
        events: {
          onhover: {
            enable: true,
            mode: 'grab'
          },
          onclick: {
            enable: true,
            mode: 'push'
          },
          resize: true
        },
        modes: {
          grab: {
            distance: 140,
            line_linked: {
              opacity: 0.3
            }
          },
          push: {
            particles_nb: 3
          }
        }
      },
      retina_detect: true
    });

  }

});

//  COUNTER ANIMATION  
const counterElements = document.querySelectorAll('.counter-value');
const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const target = parseInt(entry.target.getAttribute('data-target'));
      const duration = 2000;
      const step = target / (duration / 16);
      let current = 0;

      const updateCounter = () => {
        current += step;
        if (current < target) {
          entry.target.textContent = Math.floor(current);
          requestAnimationFrame(updateCounter);
        } else {
          entry.target.textContent = target;
        }
      };

      updateCounter();
      counterObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.5 });

counterElements.forEach(counter => {
  counterObserver.observe(counter);
});

//  PROJECTS FILTER  
$(function () {
  if ($('.item-grid').length > 0) {
    var filterList = {
      init: function () {
        $('.item-grid').mixItUp({
          selectors: {
            target: '.item',
            filter: '.filter-btn'
          },
          load: {
            filter: 'all'
          }
        });
      }
    };
    filterList.init();
  }
});

// SKILL BARS ANIMATION  
const skillBars = document.querySelectorAll('.skill-progress');
const skillObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const width = entry.target.getAttribute('data-width');
      entry.target.style.width = width + '%';
      skillObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.5 });

skillBars.forEach(bar => {
  skillObserver.observe(bar);
});
//  DATE PICKER  

if ($('input[name="dates"]').length) {

  $('input[name="dates"]').daterangepicker();

}
// Quantity selector
const decrementBtn = document.getElementById('decrement');
const incrementBtn = document.getElementById('increment');
const quantityInput = document.getElementById('quantityInput');

if (decrementBtn && incrementBtn && quantityInput) {

  decrementBtn.addEventListener('click', () => {
    let val = parseInt(quantityInput.value);
    if (val > 1) quantityInput.value = val - 1;
  });

  incrementBtn.addEventListener('click', () => {
    let val = parseInt(quantityInput.value);
    quantityInput.value = val + 1;
  });
}

// Product detail page
if ($('.productSwiper').length && $('.thumb-swiper').length) {

  const thumbSwiper = new Swiper('.thumb-swiper', {
    slidesPerView: 3,
    spaceBetween: 10,
    watchSlidesProgress: true,
    navigation: {
      nextEl: '.thumb-next',
      prevEl: '.thumb-prev',
    },
  });

  const productSwiper = new Swiper('.productSwiper', {
    slidesPerView: 1,
    effect: 'slide',
  });

  const thumbs = document.querySelectorAll('.thumb-swiper .swiper-slide');

  if (thumbs.length) {

    thumbs[0].classList.add('swiper-slide-thumb-active');

    thumbs.forEach((thumb, index) => {
      thumb.addEventListener('click', () => {
        setActiveThumb(index);
      });
    });

    function setActiveThumb(index) {
      thumbs.forEach(t => t.classList.remove('swiper-slide-thumb-active'));

      thumbs[index].classList.add('swiper-slide-thumb-active');

      productSwiper.slideTo(index);
      thumbSwiper.slideTo(index);
    }

    const nextBtn = document.querySelector('.thumb-next');
    const prevBtn = document.querySelector('.thumb-prev');

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        let activeIndex = [...thumbs].findIndex(item =>
          item.classList.contains('swiper-slide-thumb-active')
        );

        activeIndex = (activeIndex + 1) % thumbs.length;

        setActiveThumb(activeIndex);
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        let activeIndex = [...thumbs].findIndex(item =>
          item.classList.contains('swiper-slide-thumb-active')
        );

        activeIndex =
          activeIndex <= 0 ? thumbs.length - 1 : activeIndex - 1;

        setActiveThumb(activeIndex);
      });
    }
  }
  new Swiper(".tr-hero-swiper-2", {

    loop: true,

    speed: 1200,

    autoplay: {
      delay: 5000,
      disableOnInteraction: false
    },

    pagination: {
      el: ".tr-hero-pagination-2",
      clickable: true
    },

    navigation: {
      nextEl: ".tr-hero-next-2",
      prevEl: ".tr-hero-prev-2"
    }
  });

  document.addEventListener("DOMContentLoaded", function () {

    const menuBtn = document.getElementById("menuBtn2");
    const closeBtn = document.getElementById("closeBtn2");
    const overlay = document.getElementById("overlayMenu2");

    function openMenu() {
      overlay.classList.add("active");
      menuBtn.classList.add("active");
      document.body.style.overflow = "hidden";
    }

    function closeMenu() {
      overlay.classList.remove("active");
      menuBtn.classList.remove("active");
      document.body.style.overflow = "";
    }

    menuBtn.addEventListener("click", openMenu);
    closeBtn.addEventListener("click", closeMenu);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        closeMenu();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeMenu();
      }
    });

  });
}

// Tools Sidebar
$('.tr-tools-sidebar-toggle').on("click", function () {
  $('.tr-tools-sidebar').addClass("open-tools");
  $('.tr-tools-sidebar-overlay').fadeIn();
  $('.tr-tools-sidebar-toggle').hide();

});
$('.tr-tools-sidebar-overlay, .close-tools').on("click", function () {
  $('.tr-tools-sidebar').removeClass("open-tools");
  $('.tr-tools-sidebar-overlay').fadeOut();
  $('.tr-tools-sidebar-toggle').fadeIn();
});

// color show
  $(".tr-color li").on("click", function () {
    $("li").removeClass("active-variant");
    $(this).addClass("active-variant");
  });

  $(".color-primary").on("click", function () {
    $("#add_class").remove();
  });

  $(".color-1").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-1.css" id="add_class">'
    );
  });
  $(".color-2").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-2.css" id="add_class">'
    );
  });
  $(".color-3").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-3.css" id="add_class">'
    );
  });
  $(".color-4").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-4.css" id="add_class">'
    );
  });
  $(".color-5").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-5.css" id="add_class">'
    );
  });
  $(".color-6").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-6.css" id="add_class">'
    );
  });
  $(".color-7").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-7.css" id="add_class">'
    );
  });
  $(".color-8").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-8.css" id="add_class">'
    );
  });
  $(".color-9").on("click", function () {
    $("#add_class").remove();
    $("head").append(
      '<link rel="stylesheet" href="assets/css/color-9.css" id="add_class">'
    );
  });

  // RTL-LTR Modes
  $(".tr-tools-rtl .tr-tools-item").on("click", function () {
    $(".rtl-mode").removeClass("active-rtl");
    $(this).addClass("active-rtl");
  });
  $(".ltr").on("click", function () {
    $("#add_rtl").remove();
  });
  $(".rtl").on("click", function () {
    $("head").append(
      '<link rel="stylesheet" href="assets/css/rtl.css" id="add_rtl">'
    );
  });

  // Dark Light Modes
  $(".tr-tools-dark .tr-tools-item").on("click", function () {
    $(".mode-dark").removeClass("active-mode");
    $(this).addClass("active-mode");
  });
  $(".light").on("click", function () {
    $("head").append(
      '<link rel="stylesheet" href="assets/css/light-mode.css" id="add_dark">'
    );
  });
  $(".dark").on("click", function () {
    $("#add_dark").remove();
  });