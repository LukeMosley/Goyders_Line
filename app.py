#Goyder's Line application
# app.py
import streamlit as st
from streamlit_folium import st_folium
import folium
from folium.raster_layers import ImageOverlay
import json
from pathlib import Path

st.set_page_config(
    page_title="Goyder's Line Explorer",
    page_icon="🌾",
    layout="wide",
)

st.title("Goyder's Line – South Australia")
st.caption("Stage 1 · Rainfall overlays (SILO 2015–2026)")

# ---------- paths ----------
GEOJSON_PATH = Path("goyders_line_4326.geojson")
BOUNDS_PATH = Path("rainfall_overlays/bounds.json")
OVERLAY_DIR = Path("rainfall_overlays")
PORTRAIT_PATH = Path("assets/george-goyder.jpeg")

# ---------- load static data ----------
@st.cache_data
def load_geojson():
    with open(GEOJSON_PATH) as f:
        return json.load(f)

@st.cache_data
def load_bounds():
    with open(BOUNDS_PATH) as f:
        return json.load(f)

geojson_data = load_geojson()
bounds_dict = load_bounds()

# ---------- sidebar ----------
with st.sidebar:
    st.header("Layers")

    show_line = st.checkbox("Goyder's Line", value=True)
    show_rain = st.checkbox("Monthly Rainfall", value=True)

    st.markdown("---")
    st.subheader("Rainfall controls")

    year = st.selectbox("Year", options=list(range(2015, 2027)), index=10)  # default ~2025
    month = st.selectbox(
        "Month",
        options=list(range(1, 13)),
        format_func=lambda m: f"{m:02d}",
        index=5,  # default June
    )

    opacity = st.slider("Rainfall opacity", 0.0, 1.0, 0.65, 0.05)

    st.markdown("---")
    st.subheader("George Woodroffe Goyder")
    if PORTRAIT_PATH.exists():
        st.image(str(PORTRAIT_PATH), caption="George Woodroffe Goyder (1820–1898)", use_container_width=True)
    st.caption("Source: State Library of South Australia, B 496")
    st.markdown(
        "Surveyor-General of South Australia who, in 1865, "
        "mapped the approximate northern limit of reliable rainfall for cropping."
    )

# ---------- build map ----------
m = folium.Map(
    location=[-33.5, 137.5],
    zoom_start=7,
    tiles="CartoDB positron",
    control_scale=True,
)

folium.TileLayer("OpenStreetMap", name="OpenStreetMap").add_to(m)
folium.TileLayer(
    tiles="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attr="Esri",
    name="Satellite",
).add_to(m)

# Rainfall overlay
if show_rain:
    key = f"{year}-{month:02d}"
    png_path = OVERLAY_DIR / f"rain_{year}_{month:02d}.png"

    if png_path.exists() and key in bounds_dict:
        ImageOverlay(
            name=f"Rainfall {year}-{month:02d}",
            image=str(png_path),
            bounds=bounds_dict[key],
            opacity=opacity,
            interactive=True,
            cross_origin=False,
            zindex=1,
        ).add_to(m)
    else:
        st.sidebar.warning(f"No rainfall overlay for {year}-{month:02d}")

# Goyder's Line (drawn on top)
if show_line:
    folium.GeoJson(
        geojson_data,
        name="Goyder's Line",
        style_function=lambda x: {
            "color": "#8B0000",
            "weight": 4,
            "opacity": 0.95,
        },
        tooltip=folium.GeoJsonTooltip(
            fields=["OBJECTID"],
            aliases=["Segment"],
            sticky=True,
        ),
        highlight_function=lambda x: {"weight": 6, "color": "#FF4500"},
    ).add_to(m)

folium.LayerControl(collapsed=False).add_to(m)

st_folium(m, width=None, height=720, returned_objects=[])

st.markdown("---")
st.caption(
    "Rainfall data: SILO (Queensland Government) gridded monthly rainfall. "
    "Goyder's Line: SA Department for Environment and Water."
)
