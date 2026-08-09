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

st.markdown(
    """
    <style>
        /* Reduce top padding */
        .block-container {
            padding-top: 1.5rem !important;
            padding-bottom: 1rem !important;
        }
        h1 {
            margin-top: 0rem !important;
            margin-bottom: 0.3rem !important;
            font-size: 1.8rem !important;
        }
        .stCaption {
            margin-top: -0.4rem !important;
            margin-bottom: 0.8rem !important;
        }

        /* Keep Folium zoom controls visible and on top */
        .leaflet-control-zoom {
            z-index: 1001 !important;
            margin-top: 60px !important;
            margin-left: 10px !important;
        }

        /* Make sure the zoom buttons stay clickable */
        .leaflet-bar a {
            z-index: 1002 !important;
        }
    </style>
    """,
    unsafe_allow_html=True,
)

st.markdown("### Goyder's Line – South Australia")
st.caption("Rainfall overlays from SILO")

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

# ---------- session state for map view ----------
if "map_center" not in st.session_state:
    st.session_state.map_center = [-33.5, 137.5]
if "map_zoom" not in st.session_state:
    st.session_state.map_zoom = 7

# ---------- sidebar ----------
with st.sidebar:
    st.header("Layers")
    show_line = st.checkbox("Goyder's Line", value=True)
    show_rain = st.checkbox("Monthly Rainfall", value=True)

    st.markdown("---")
    st.subheader("Rainfall controls")

    available_years = list(range(2015, 2027))
    year = st.selectbox("Year", options=available_years, index=len(available_years) - 1)

    possible_months = []
    for m in range(1, 13):
        if (OVERLAY_DIR / f"rain_{year}_{m:02d}.png").exists():
            possible_months.append(m)
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

# ---------- colour legend (top-right) ----------
legend_html = """
{% macro html(this, kwargs) %}
<div style="
    position: fixed;
    top: 60px;
    right: 20px;
    z-index: 1000;
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

# ---------- session state ----------
if "map_center" not in st.session_state:
    st.session_state.map_center = [-33.5, 137.5]
if "map_zoom" not in st.session_state:
    st.session_state.map_zoom = 7

# ---------- build map ----------
m = folium.Map(
    location=st.session_state.map_center,
    zoom_start=st.session_state.map_zoom,
    tiles=None,
    control_scale=True,
)

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

# ---------- CRITICAL: stable key + pass center/zoom ----------
# Key only changes when the rainfall data itself changes
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

# Safely update session state only when we receive new values
if map_data is not None:
    new_center = map_data.get("last_center")
    new_zoom = map_data.get("last_zoom")

    if new_center is not None:
        st.session_state.map_center = [new_center["lat"], new_center["lng"]]
    if new_zoom is not None:
        st.session_state.map_zoom = new_zoom

st.markdown("---")
st.caption(
    "Rainfall data: SILO (Queensland Government). "
    "Goyder's Line: SA Department for Environment and Water."
)
