# app.py
import streamlit as st
from streamlit_folium import st_folium
import folium
from folium.raster_layers import ImageOverlay
from branca.element import Template, MacroElement
import json
from pathlib import Path

st.set_page_config(
    page_title="Goyder's Line Explorer",
    page_icon="🌾",
    layout="wide",
)

# ---------- CSS ----------
st.markdown(
    """
    <style>
        .block-container {
            padding-top: 1rem !important;
            padding-bottom: 1rem !important;
        }

        /* Force zoom control to bottom-left */
        .leaflet-top.leaflet-left {
            top: auto !important;
            bottom: 25px !important;
            left: 10px !important;
            right: auto !important;
        }

        .leaflet-control-zoom {
            position: relative !important;
            z-index: 1001 !important;
        }

        /* Extra specificity in case Folium re-injects the control */
        .leaflet-left .leaflet-control-zoom {
            top: auto !important;
            bottom: 25px !important;
        }
    </style>
    """,
    unsafe_allow_html=True,
)

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

# ---------- session state ----------
if "map_center" not in st.session_state:
    st.session_state.map_center = [-33.5, 137.5]
if "map_zoom" not in st.session_state:
    st.session_state.map_zoom = 7

# ---------- sidebar ----------
with st.sidebar:
    st.markdown("### Goyder's Line")
    st.caption("South Australia · SILO rainfall 2015–2026")
    st.markdown("---")

    st.header("Layers")
    show_line = st.checkbox("Goyder's Line", value=True)
    show_rain = st.checkbox("Monthly Rainfall", value=True)

    st.markdown("---")
    st.subheader("Rainfall controls")

    available_years = list(range(2015, 2027))
    year = st.selectbox("Year", options=available_years, index=len(available_years) - 1)

    possible_months = [
        m for m in range(1, 13)
        if (OVERLAY_DIR / f"rain_{year}_{m:02d}.png").exists()
    ]
    if not possible_months:
        possible_months = list(range(1, 13))

    month = st.selectbox(
        "Month",
        options=possible_months,
        format_func=lambda m: f"{m:02d}",
        index=len(possible_months) - 1,
    )

    opacity = st.slider("Rainfall opacity", 0.0, 1.0, 0.65, 0.05)

    st.markdown("---")
    st.subheader("George Woodroffe Goyder")
    if PORTRAIT_PATH.exists():
        st.image(
            str(PORTRAIT_PATH),
            caption="George Woodroffe Goyder (1820–1898)",
            use_container_width=True,
        )
    st.caption("Source: State Library of South Australia, B 496")
    st.markdown(
        "Surveyor-General of South Australia who, in 1865, "
        "mapped the approximate northern limit of reliable rainfall for cropping "
        "(~250–300 mm annual isohyet)."
    )

# ---------- rainfall legend (top-right) ----------
legend_html = """
{% macro html(this, kwargs) %}
<div style="
    position: fixed;
    top: 80px;
    right: 20px;
    z-index: 999;
    background: white;
    padding: 10px 14px;
    border-radius: 6px;
    border: 1px solid #999;
    font-size: 13px;
    font-family: Arial, sans-serif;
    box-shadow: 0 1px 4px rgba(0,0,0,0.3);
">
    <div style="font-weight: bold; margin-bottom: 6px;">Monthly rainfall (mm)</div>
    <div style="
        width: 160px;
        height: 14px;
        background: linear-gradient(to right, #ffffd9, #edf8b1, #c7e9b4, #7fcdbb, #41b6c4, #1d91c0, #225ea8, #0c2c84);
        border: 1px solid #666;
        margin-bottom: 4px;
    "></div>
    <div style="display: flex; justify-content: space-between; font-size: 12px;">
        <span>0</span>
        <span>150</span>
    </div>
</div>
{% endmacro %}
"""

class RainfallLegend(MacroElement):
    def __init__(self):
        super().__init__()
        self._template = Template(legend_html)

# ---------- build map ----------
m = folium.Map(
    location=st.session_state.map_center,
    zoom_start=st.session_state.map_zoom,
    tiles=None,
    control_scale=True,
    zoom_control=False,          # turn off the default top-left control
)

# Add zoom control in the bottom-left
from folium.map import ZoomControl
ZoomControl(position="bottomleft").add_to(m)

folium.TileLayer("CartoDB positron", name="Light map").add_to(m)
folium.TileLayer("OpenStreetMap", name="Street map").add_to(m)
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
            interactive=False,
            cross_origin=False,
            zindex=1,
        ).add_to(m)
    else:
        st.sidebar.warning(f"No rainfall overlay for {year}-{month:02d}")

# Goyder's Line
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
    ).add_to(m)

m.get_root().add_child(RainfallLegend())

# ---------- render map ----------
map_key = f"map_{year}_{month:02d}"

map_data = st_folium(
    m,
    center=st.session_state.map_center,
    zoom=st.session_state.map_zoom,
    key=map_key,
    height=720,
    width=None,
    returned_objects=["last_center", "last_zoom"],
    use_container_width=True,
)

# Update view state
if map_data is not None:
    new_center = map_data.get("last_center")
    new_zoom = map_data.get("last_zoom")
    if new_center is not None:
        st.session_state.map_center = [new_center["lat"], new_center["lng"]]
    if new_zoom is not None:
        st.session_state.map_zoom = new_zoom

st.caption(
    "Rainfall data: SILO (Queensland Government). "
    "Goyder's Line: SA Department for Environment and Water."
)
