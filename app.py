# app.py
import streamlit as st
from streamlit_folium import st_folium
import folium
import geopandas as gpd
from pathlib import Path

st.set_page_config(
    page_title="Goyder's Line Explorer",
    page_icon="🌾",
    layout="wide",
)

st.title("Goyder's Line – South Australia")
st.caption("Stage 0 · Official DEW line (GDA2020 → WGS84)")

@st.cache_data
def load_line():
    return gpd.read_file("goyders_line_4326.geojson")

gdf = load_line()

with st.sidebar:
    st.header("Layers")
    show_line = st.checkbox("Goyder's Line", value=True)
    st.markdown("---")
    st.caption("Source: SA Department for Environment and Water")

# Map
m = folium.Map(
    location=[-33.5, 137.5],
    zoom_start=6,
    tiles="CartoDB positron",
    control_scale=True,
)

folium.TileLayer("OpenStreetMap", name="OpenStreetMap").add_to(m)
folium.TileLayer(
    tiles="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attr="Esri",
    name="Satellite",
).add_to(m)

if show_line:
    folium.GeoJson(
        gdf,
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
    "Goyder's Line approximates the northern limit of reliable cropping rainfall "
    "as assessed by Surveyor-General George Goyder in 1865 (~250–300 mm isohyet)."
)
