# Goyder's line
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

st.title("Goyder's Line – South Australia")
st.caption("Rainfall overlays from SILO (2015–2026)")

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

    year = st.selectbox("Year", options=list(range(2015, 2027)), index=10)
    month = st.selectbox(
        "Month",
        options=list(range(1, 13)),
        format_func=lambda m: f"{m:02d}",
        index=5,
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

# ---------- colour legend (HTML) ----------
legend_html = """
{% macro html(this, kwargs) %}
<div style="
    position: fixed;
    bottom: 30px;
    left: 30px;
    z-index: 1000;
    background: white;
    padding: 10px 14px;
    border-radius: 6px;
    border: 1px solid #999;
    font-size: 13px;
    font-family: Arial, sans-serif;
    box-shadow: 0 1px 4px rgba(0,0,0,0.3);
">
    <div style="font-weight: bold; margin-bottom: 6px;">Monthly rainfall</div>
    <div style="
        width: 160px;
        height: 14px;
        background: linear-gradient(to right, #ffffd9, #edf8b1, #c7e9b4, #7fcdbb, #41b6c4, #1d91c0, #225ea8, #0c2c84);
        border: 1px solid #666;
        margin-bottom: 4px;
    "></div>
    <div style="display: flex; justify-content: space-between; font-size: 12px;">
        <span>Low</span>
        <span>High</span>
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
    location=[-33.5, 137.5],
    zoom_start=6,
    tiles=None,
    control_scale=True,
)

# Friendly basemap names
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
            interactive=True,
            cross_origin=False,
            zindex=1,
        ).add_to(m)
    else:
        st.sidebar.warning(f"No rainfall overlay for {year}-{month:02d}")

# Goyder's Line (drawn last so it sits on top)
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

# Layer control – bottom right
folium.LayerControl(collapsed=False, position="bottomright").add_to(m)

# Add the colour legend
m.get_root().add_child(RainfallLegend())

# Render map
st_folium(m, width=None, height=720, returned_objects=[])

# ---------- footer + save tip ----------
st.markdown("---")
st.caption(
    "Rainfall data: SILO (Queensland Government). "
    "Goyder's Line: SA Department for Environment and Water."
)

st.info(
    "**Tip – Save map as image:** Right-click on the map → “Save image as…” "
    "(Chrome / Edge) or use your system screenshot tool (Windows: Win+Shift+S)."
)
